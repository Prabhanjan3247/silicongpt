import { useState, type ReactNode } from 'react';
import { ChartColumn, Cpu, FileText, Info, ShieldAlert, TriangleAlert } from 'lucide-react';
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format';
import { Card } from '../ui/Card';
import { KeyValue } from '../ui/KeyValue';
import { StatusBadge } from '../ui/StatusBadge';
import { Tabs } from '../ui/Tabs';
import { LogViewer } from '../run/LogViewer';
import { CellTypeChart } from './CellTypeChart';
import { SynthStatsGrid } from './SynthStatsGrid';
import { cellCounts, type SynthRunInfo } from './synthMetrics';

type PanelTab = 'cells' | 'log' | 'details';

export interface SynthRunPanelProps {
  run: SynthRunInfo;
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** One Yosys run: headline statistics, cell-type breakdown, the real log and run details. */
export function SynthRunPanel({ run, title, actions, className }: SynthRunPanelProps) {
  const [selectedTab, setTab] = useState<PanelTab>(run.status === 'ok' ? 'cells' : 'log');
  const ok = run.status === 'ok';
  // A failed run has no cell statistics: fall back to its log.
  const tab: PanelTab = !ok && selectedTab === 'cells' ? 'log' : selectedTab;
  const errors = Array.isArray(run.errors) ? run.errors : [];
  const violations = Array.isArray(run.policy_violations) ? run.policy_violations : [];

  return (
    <Card
      className={className}
      icon={<Cpu />}
      title={
        <span className="flex items-center gap-2">
          {title ?? `Synthesis run #${run.id}`}
          <StatusBadge kind="synth" status={run.status} />
        </span>
      }
      description={
        <span title={formatDateTime(run.created_at)}>
          Label “{run.label}” · top <span className="font-mono">{run.top || '—'}</span> · Yosys {formatDuration(run.duration_ms)} ·{' '}
          {formatRelative(run.created_at)}
        </span>
      }
      actions={actions}
    >
      <div className="grid gap-4">
        {ok ? (
          <SynthStatsGrid stats={run.stats} />
        ) : (
          <p className="rounded-lg border border-fail/30 bg-fail/[0.06] px-3 py-2 text-xs leading-5 text-[#fecaca]">
            {run.status === 'blocked'
              ? 'The source policy rejected the design before Yosys ran: no statistics were produced.'
              : 'Yosys did not finish successfully: no statistics were produced. The log shows the error.'}
          </p>
        )}

        {(run.warnings.length > 0 || errors.length > 0 || violations.length > 0) && (
          <ul className="grid gap-1.5">
            {errors.map((e, i) => (
              <li key={`e-${i}`} className="flex items-start gap-2 text-xs leading-5 text-[#fca5a5]">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fail" />
                {e}
              </li>
            ))}
            {violations.map((v, i) => (
              <li key={`p-${i}`} className="flex items-start gap-2 text-xs leading-5 text-[#ddd6fe]">
                <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-violet" />
                <span>
                  {v.file ? <span className="font-mono text-2xs">{`${v.file}:${v.line ?? ''} `}</span> : null}
                  {v.message ?? v.rule ?? 'policy violation'}
                </span>
              </li>
            ))}
            {run.warnings.map((w, i) => (
              <li key={`w-${i}`} className="flex items-start gap-2 text-xs leading-5 text-[#fcd34d]">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
                {w}
              </li>
            ))}
          </ul>
        )}

        <div>
          <Tabs<PanelTab>
            aria-label="Synthesis details"
            size="sm"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'cells', label: 'Cell types', icon: <ChartColumn aria-hidden="true" />, disabled: !ok },
              { id: 'log', label: 'Yosys log', icon: <FileText aria-hidden="true" /> },
              { id: 'details', label: 'Details', icon: <Info aria-hidden="true" /> },
            ]}
          />
          <div className="pt-3">
            {tab === 'cells' && ok && <CellTypeChart baseline={cellCounts(run.stats)} />}
            {tab === 'log' && (
              <LogViewer text={run.log} height={360} emptyText="Yosys printed nothing." downloadName={`yosys-run-${run.id}.log`} />
            )}
            {tab === 'details' && (
              <KeyValue
                columns={2}
                dense
                items={[
                  { label: 'Top module', value: run.top || null, mono: true },
                  { label: 'Label', value: run.label },
                  { label: 'Yosys', value: run.tool_version ?? null, mono: true, title: run.tool_version ?? undefined },
                  { label: 'Run time', value: formatDuration(run.duration_ms) },
                  { label: 'Files read', value: Array.isArray(run.read_files) && run.read_files.length > 0 ? run.read_files.join(', ') : null, mono: true, wrap: true },
                  { label: 'Statistics source', value: run.stats.stat_source ?? null, mono: true },
                  { label: 'Recorded', value: formatDateTime(run.created_at) },
                  { label: 'Flow', value: 'synth -top <top> -flatten; stat -json; ltp -noff', mono: true, wrap: true },
                ]}
              />
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
