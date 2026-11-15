import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Counter or badge shown after the label. */
  badge?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface TabsProps<T extends string = string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** underline: section tabs; pills: compact segmented control. */
  variant?: 'underline' | 'pills';
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
  /** Prefix for ids: tab = `${idPrefix}-tab-${id}`, panel = `${idPrefix}-panel-${id}`. */
  idPrefix?: string;
}

/**
 * Controlled tab list (render the active panel yourself). Arrow keys / Home / End move between
 * enabled tabs.
 */
export function Tabs<T extends string = string>({
  tabs,
  value,
  onChange,
  variant = 'underline',
  size = 'md',
  className,
  idPrefix,
  'aria-label': ariaLabel,
}: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const current = tabs.findIndex((t) => t.id === value);
    const pos = Math.max(0, enabled.indexOf(current));
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = enabled[(pos + 1) % enabled.length] ?? null;
    else if (event.key === 'ArrowLeft') next = enabled[(pos - 1 + enabled.length) % enabled.length] ?? null;
    else if (event.key === 'Home') next = enabled[0] ?? null;
    else if (event.key === 'End') next = enabled[enabled.length - 1] ?? null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) {
      onChange(tab.id);
      refs.current[next]?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={clsx(
        'flex min-w-0 items-center overflow-x-auto',
        variant === 'underline' ? 'gap-1 border-b border-border' : 'gap-0.5 rounded-lg border border-border bg-surface p-0.5',
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${tab.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${tab.id}` : undefined}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={tab.disabled}
            title={tab.title}
            onClick={() => onChange(tab.id)}
            className={clsx(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-3.5',
              size === 'sm' ? 'text-xs' : 'text-[13px]',
              variant === 'underline'
                ? clsx(
                    '-mb-px border-b-2 px-3',
                    size === 'sm' ? 'h-8' : 'h-9',
                    active
                      ? 'border-accent text-text'
                      : 'border-transparent text-muted hover:border-border-strong hover:text-text',
                  )
                : clsx(
                    'rounded-md px-2.5',
                    size === 'sm' ? 'h-6' : 'h-7',
                    active
                      ? 'bg-raised text-text shadow-[0_0_0_1px_rgba(43,58,82,0.9)]'
                      : 'text-muted hover:bg-raised/60 hover:text-text',
                  ),
            )}
          >
            {tab.icon && <span className={clsx(active ? 'text-accent' : 'text-subtle')}>{tab.icon}</span>}
            {tab.label}
            {tab.badge !== undefined && tab.badge !== null && (
              <span
                className={clsx(
                  'rounded-full px-1.5 text-[10.5px] leading-4 tabular-nums',
                  active ? 'bg-accent/15 text-[#67e8f9]' : 'bg-raised text-muted',
                )}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
