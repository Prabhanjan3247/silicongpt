import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';
import type { Tone } from '../../lib/status';

export type { Tone } from '../../lib/status';

export type BadgeSize = 'xs' | 'sm' | 'md';

const TONE: Record<Tone, string> = {
  neutral: 'bg-[#1a2436] text-[#a9b6cb] ring-[#2b3a52]',
  accent: 'bg-accent/10 text-[#67e8f9] ring-accent/30',
  blue: 'bg-blue/15 text-[#93c5fd] ring-blue/35',
  pass: 'bg-pass/10 text-[#4ade80] ring-pass/30',
  fail: 'bg-fail/10 text-[#f87171] ring-fail/35',
  warn: 'bg-warn/10 text-[#fbbf24] ring-warn/30',
  violet: 'bg-violet/10 text-[#c4b5fd] ring-violet/30',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-[#8b9bb4]',
  accent: 'bg-accent',
  blue: 'bg-blue',
  pass: 'bg-pass',
  fail: 'bg-fail',
  warn: 'bg-warn',
  violet: 'bg-violet',
};

const SIZE: Record<BadgeSize, string> = {
  xs: 'h-[18px] gap-1 px-1.5 text-[10.5px] [&_svg]:size-3',
  sm: 'h-5 gap-1 px-2 text-2xs [&_svg]:size-3',
  md: 'h-6 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: BadgeSize;
  /** Leading icon element (sized automatically). */
  icon?: ReactNode;
  /** Leading coloured dot. */
  dot?: boolean;
  /** Monospace text (values, ids, tool names). */
  mono?: boolean;
}

/** Small status / metadata pill. Colour never carries meaning alone: always give it text. */
export function Badge({ tone = 'neutral', size = 'sm', icon, dot = false, mono = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-full font-medium ring-1 ring-inset',
        TONE[tone],
        SIZE[size],
        mono && 'font-mono',
        className,
      )}
      {...rest}
    >
      {dot && <span aria-hidden="true" className={clsx('size-1.5 shrink-0 rounded-full', DOT[tone])} />}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Text colour class for a tone (for icons or values outside a badge). */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  accent: 'text-accent',
  blue: 'text-[#60a5fa]',
  pass: 'text-pass',
  fail: 'text-fail',
  warn: 'text-warn',
  violet: 'text-violet',
};
