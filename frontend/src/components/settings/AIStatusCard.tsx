import { Bot, CircleCheck, Lock, TriangleAlert } from 'lucide-react';
import type { AIStatus } from '../../services/types';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { EmptyState } from '../ui/EmptyState';
import { KeyValue } from '../ui/KeyValue';
import { LoadingState } from '../ui/Spinner';

const AI_FEATURES = [
  'AI Generator (architecture + RTL)',
  'AI testbench generation',
  'Explain code',
  'Run analysis and AI Debugger',
  'AI optimization',
  'Assistant questions',
];

const TOOL_FEATURES = ['Editing, lint and compile', 'Simulation (Icarus / Verilator)', 'Waveforms', 'Yosys synthesis', 'Reports'];

export interface AIStatusCardProps {
  ai: AIStatus | null;
  loading: boolean;
}

/** Claude configuration status (never the credentials) and how to configure them on the backend. */
export function AIStatusCard({ ai, loading }: AIStatusCardProps) {
  const envSnippet = ['ANTHROPIC_API_KEY=<your Anthropic API key>', `SGPT_MODEL=${ai?.model || 'claude-opus-5-5'}`, `SGPT_AI_FALLBACKS=${ai ? String(ai.fallbacks) : 'true'}`].join('\n');

  return (
    <Card
      icon={<Bot />}
      title="Claude AI"
      description="Configuration reported by the backend. Credentials are never sent to the browser."
      actions={
        ai ? (
          ai.configured ? (
            <Badge tone="pass" size="md" icon={<CircleCheck aria-hidden="true" />}>
              Configured
            </Badge>
          ) : (
            <Badge tone="warn" size="md" icon={<TriangleAlert aria-hidden="true" />}>
              Not configured
            </Badge>
          )
        ) : undefined
      }
    >
      {!ai ? (
        loading ? (
          <LoadingState label="Checking AI configuration…" minHeight="6rem" />
        ) : (
          <EmptyState compact icon={<TriangleAlert />} title="AI status unavailable" description="The backend did not answer GET /api/system/status." />
        )
      ) : (
        <div className="grid gap-4">
          <KeyValue
            columns={3}
            dense
            items={[
              { label: 'Credentials', value: ai.configured ? 'Present on the backend' : 'Not configured' },
              { label: 'Model', value: ai.model, mono: true },
              { label: 'Server-side fallbacks', value: ai.fallbacks ? 'Enabled' : 'Disabled' },
            ]}
          />

          {ai.configured ? (
            <p className="text-xs leading-5 text-muted">
              Credentials exist on the backend. They are checked by the first AI request: an invalid or revoked key makes AI
              requests fail with HTTP 503, which the pages show as an error.
            </p>
          ) : (
            <p className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-xs leading-5 text-[#efd9a8]">
              AI requests answer HTTP 503 (“Claude API credentials not configured”) until a key is configured. Everything that
              runs real tools keeps working without AI.
            </p>
          )}

          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-text">Configure the API key on the backend</h4>
            <ol className="grid list-decimal gap-1 pl-5 text-xs leading-5 text-[#c3cede] marker:text-subtle">
              <li>
                On the machine that runs the backend, open <code className="font-mono text-[#a5f3fc]">backend/.env</code> (create
                it if it does not exist), or set the variables in the backend process environment.
              </li>
              <li>Add your Anthropic API key (the model and fallback lines are optional).</li>
              <li>Restart the backend. The status here is re-checked every 60 seconds, or use “Refresh status”.</li>
            </ol>
            <div className="mt-2 overflow-hidden rounded-lg border border-border bg-surface">
              <div className="flex h-7 items-center justify-between border-b border-border bg-[#0d1526] pl-3 pr-1">
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-subtle">backend/.env</span>
                <CopyButton text={envSnippet} iconOnly size="xs" label="Copy .env template" />
              </div>
              <pre className="m-0 overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-[#cbd5e1]">{envSnippet}</pre>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface/60 px-3 py-2.5">
            <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
            <p className="text-xs leading-5 text-muted">
              SiliconGPT never accepts an API key in the browser, and this page has no field for one. The backend reads the key
              from its own environment, never returns or logs it, and <span className="font-mono">/api/system/status</span>{' '}
              only reports whether credentials exist.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">Needs Claude</h4>
              <ul className="grid gap-0.5 text-xs text-[#c3cede]">
                {AI_FEATURES.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">Works without Claude</h4>
              <ul className="grid gap-0.5 text-xs text-[#c3cede]">
                {TOOL_FEATURES.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
