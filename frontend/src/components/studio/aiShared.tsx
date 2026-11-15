import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { AIRecord } from '../../services/types';
import { formatCompact, formatDuration, formatRelative } from '../../lib/format';
import { useProject } from '../../state/ProjectContext';

/** Seconds elapsed since `start` while `active` (re-renders once per second). */
export function useElapsed(start: number | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (start === null) return 0;
  return Math.max(0, Math.round((now - start) / 1000));
}

/** Model / tokens / duration of a stored AI interaction. */
export function InteractionMeta({ interaction, className }: { interaction: AIRecord | undefined; className?: string }) {
  if (!interaction) return null;
  return (
    <p className={className ?? 'text-2xs leading-4 text-subtle'}>
      {interaction.model || 'model n/a'} · {formatCompact(interaction.input_tokens)} in / {formatCompact(interaction.output_tokens)} out
      tokens · {formatDuration(interaction.duration_ms)} · {formatRelative(interaction.created_at)} · record #{interaction.id}
    </p>
  );
}

/**
 * Warns that the backend reported no Claude credentials. Requests are still sent (the backend's
 * real HTTP 503 error is shown), so the note never replaces an actual result.
 */
export function AIConfigNote() {
  const { systemStatus } = useProject();
  if (!systemStatus || systemStatus.ai?.configured !== false) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.06] px-2.5 py-2 text-2xs leading-4 text-[#efd9a8]">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden="true" />
      <span>
        The backend reports that Claude API credentials are not configured, so AI requests are expected to fail with
        HTTP 503 until ANTHROPIC_API_KEY is set for the server.
      </span>
    </p>
  );
}
