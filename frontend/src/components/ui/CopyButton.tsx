import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, type ButtonSize, type ButtonVariant } from './Button';

export function clipboardAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.writeText);
}

export interface CopyButtonProps {
  /** Text to copy, or a function producing it at click time. */
  text: string | (() => string);
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  /** Icon-only button (label used as tooltip / aria-label). */
  iconOnly?: boolean;
  className?: string;
}

/** Copies text to the clipboard. Renders nothing when the Clipboard API is unavailable. */
export function CopyButton({ text, label = 'Copy', size = 'xs', variant = 'ghost', iconOnly = false, className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!clipboardAvailable()) return null;

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  const shown = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;
  return (
    <Button
      size={size}
      variant={variant}
      iconOnly={iconOnly}
      aria-label={shown}
      title={shown}
      icon={state === 'copied' ? <Check className="text-pass" /> : <Copy />}
      onClick={onClick}
      className={className}
    >
      {iconOnly ? null : shown}
    </Button>
  );
}
