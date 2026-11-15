import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, CircleHelp, Info, Layers, ListOrdered, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import type { ArchitectureSpec, ControlSignalSpec, SignalSpec } from '../../services/types';
import { formatNumber } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { KeyValue } from '../ui/KeyValue';

function SignalTable({ rows, empty }: { rows: readonly SignalSpec[]; empty: string }) {
  if (rows.length === 0) return <p className="px-4 py-3 text-xs text-subtle">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border text-2xs uppercase tracking-wider text-subtle">
            <th scope="col" className="px-4 py-1.5 font-medium">Signal</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Width</th>
            <th scope="col" className="px-4 py-1.5 font-medium">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((row, i) => (
            <tr key={`${row.name}-${i}`} className="align-top">
              <td className="whitespace-nowrap px-4 py-1.5 font-mono text-[12.5px] text-text">{row.name}</td>
              <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[12.5px] text-[#a5f3fc]">{String(row.width)}</td>
              <td className="px-4 py-1.5 leading-5 text-[#c3cede]">{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ControlTable({ rows }: { rows: readonly ControlSignalSpec[] }) {
  if (rows.length === 0) return <p className="px-4 py-3 text-xs text-subtle">The architect defined no control signals.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border text-2xs uppercase tracking-wider text-subtle">
            <th scope="col" className="px-4 py-1.5 font-medium">Signal</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Encoding</th>
            <th scope="col" className="px-4 py-1.5 font-medium">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((row, i) => (
            <tr key={`${row.name}-${i}`} className="align-top">
              <td className="whitespace-nowrap px-4 py-1.5 font-mono text-[12.5px] text-text">{row.name}</td>
              <td className="px-3 py-1.5 font-mono text-[12px] leading-5 whitespace-pre-wrap text-[#a5f3fc]">{row.encoding}</td>
              <td className="px-4 py-1.5 leading-5 text-[#c3cede]">{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LIST_TONE = {
  info: { icon: Info, iconClass: 'text-[#60a5fa]', border: 'border-blue/25' },
  question: { icon: CircleHelp, iconClass: 'text-accent', border: 'border-accent/25' },
  warn: { icon: TriangleAlert, iconClass: 'text-warn', border: 'border-warn/30' },
} as const;

function NoteList({ title, items, tone, empty, hint }: { title: string; items: readonly string[]; tone: keyof typeof LIST_TONE; empty: string; hint: ReactNode }) {
  const t = LIST_TONE[tone];
  const Icon = t.icon;
  return (
    <section className={clsx('min-w-0 rounded-xl border bg-surface/60 p-3.5', t.border)}>
      <header className="flex items-center gap-2">
        <Icon aria-hidden="true" className={clsx('size-4 shrink-0', t.iconClass)} />
        <h4 className="text-[13px] font-semibold text-text">{title}</h4>
        <Badge size="xs" tone="neutral" className="ml-auto">
          {formatNumber(items.length)}
        </Badge>
      </header>
      <p className="mt-0.5 text-2xs leading-4 text-subtle">{hint}</p>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-subtle">{empty}</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {items.map((item, i) => (
            <li key={`${i}-${item.slice(0, 24)}`} className="flex gap-2 text-xs leading-5 text-[#c3cede]">
              <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-subtle" />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface ArchitecturePanelProps {
  architecture: ArchitectureSpec;
}

/** Architect agent output: interface tables, control encoding, micro-architecture and the open points. */
export function ArchitecturePanel({ architecture: a }: ArchitecturePanelProps) {
  return (
    <div className="grid gap-4">
      <Card icon={<Layers />} title="Architecture definition" description="From the architect agent (Claude). Review it before relying on the RTL.">
        {a.summary && <p className="mb-4 text-[13px] leading-6 text-[#c3cede]">{a.summary}</p>}
        <KeyValue
          columns={4}
          dense
          items={[
            { label: 'Module', value: a.module_name || null, mono: true },
            {
              label: 'Type',
              value: (
                <Badge tone={a.is_sequential ? 'violet' : 'blue'} size="sm">
                  {a.is_sequential ? 'Sequential' : 'Combinational'}
                </Badge>
              ),
            },
            { label: 'Clocking', value: a.clocking || null, wrap: true },
            { label: 'Reset strategy', value: a.reset_strategy || null, wrap: true },
          ]}
        />
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card icon={<ArrowDownRight />} title="Inputs" description={`${formatNumber(a.inputs.length)} ports`} padding="none">
          <SignalTable rows={a.inputs} empty="The architect listed no inputs." />
        </Card>
        <Card icon={<ArrowUpRight />} title="Outputs" description={`${formatNumber(a.outputs.length)} ports`} padding="none">
          <SignalTable rows={a.outputs} empty="The architect listed no outputs." />
        </Card>
      </div>

      <Card icon={<SlidersHorizontal />} title="Control signals" description="Encodings chosen for mode / opcode / select inputs." padding="none">
        <ControlTable rows={a.control_signals} />
      </Card>

      {a.microarchitecture.length > 0 && (
        <Card icon={<ListOrdered />} title="Micro-architecture">
          <ol className="grid list-decimal gap-1.5 pl-5 text-xs leading-5 text-[#c3cede] marker:text-subtle">
            {a.microarchitecture.map((step, i) => (
              <li key={`${i}-${step.slice(0, 24)}`}>{step}</li>
            ))}
          </ol>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <NoteList
          title="Assumptions"
          tone="info"
          items={a.assumptions}
          hint="Decisions the architect made where the spec was silent."
          empty="None reported by the architect."
        />
        <NoteList
          title="Open questions"
          tone="question"
          items={a.open_questions}
          hint="Answer these in the spec and regenerate for a definitive design."
          empty="None reported by the architect."
        />
        <NoteList
          title="Unspecified requirements"
          tone="warn"
          items={a.unspecified_requirements}
          hint="Aspects the spec does not define (timing, error handling, corner cases…)."
          empty="None reported by the architect."
        />
      </div>
    </div>
  );
}
