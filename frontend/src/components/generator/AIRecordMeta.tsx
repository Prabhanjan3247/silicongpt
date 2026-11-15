import clsx from 'clsx';
import { Bot } from 'lucide-react';
import type { AIRecord } from '../../services/types';
import { formatDateTime, formatDuration, formatNumber, formatRelative } from '../../lib/format';

export interface AIRecordMetaProps {
  /** The interaction record returned with the AI response (persisted by the backend). */
  record: AIRecord | null | undefined;
  className?: string;
}

/** "claude-opus-5-5 · 12,345 in / 6,789 out tokens · 2m 05s · #42" for one recorded AI interaction. */
export function AIRecordMeta({ record, className }: AIRecordMetaProps) {
  if (!record) return null;
  return (
    <p
      className={clsx('flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-subtle', className)}
      title={`AI interaction #${record.id} (${record.agent} / ${record.action}) recorded ${formatDateTime(record.created_at)}`}
    >
      <Bot aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="font-mono text-muted">{record.model || 'model not reported'}</span>
      <span aria-hidden="true">·</span>
      <span className="tabular-nums">
        {formatNumber(record.input_tokens)} in / {formatNumber(record.output_tokens)} out tokens
      </span>
      <span aria-hidden="true">·</span>
      <span>{formatDuration(record.duration_ms)}</span>
      <span aria-hidden="true">·</span>
      <span>{formatRelative(record.created_at)}</span>
      <span aria-hidden="true">·</span>
      <span className="font-mono">#{record.id}</span>
    </p>
  );
}
