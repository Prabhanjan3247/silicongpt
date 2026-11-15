import { runStatusMeta, synthStatusMeta } from '../../lib/status';
import { Badge, type BadgeSize } from './Badge';

export interface StatusBadgeProps {
  /** RunStatus value (passed, failed, compile_error, runtime_error, timeout, resource_limit,
   *  no_checks, incomplete, blocked, error) or a synthesis status when kind="synth". */
  status: string | null | undefined;
  kind?: 'run' | 'synth';
  size?: BadgeSize;
  showIcon?: boolean;
  /** Overrides the label text (the tooltip still explains the status). */
  label?: string;
  className?: string;
}

/** Coloured, labelled, iconified status pill with an explanatory tooltip. */
export function StatusBadge({ status, kind = 'run', size = 'sm', showIcon = true, label, className }: StatusBadgeProps) {
  const meta = kind === 'synth' ? synthStatusMeta(status) : runStatusMeta(status);
  const Icon = meta.icon;
  return (
    <Badge
      tone={meta.tone}
      size={size}
      icon={showIcon ? <Icon aria-hidden="true" /> : undefined}
      title={meta.description}
      className={className}
      data-status={status ?? undefined}
    >
      {label ?? meta.label}
    </Badge>
  );
}
