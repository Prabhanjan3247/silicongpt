import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface KeyValueItem {
  label: ReactNode;
  /** null / undefined / '' render as an em dash. */
  value: ReactNode;
  mono?: boolean;
  /** Tooltip for the value (e.g. the untruncated text). */
  title?: string;
  key?: string;
  /** Let the value wrap instead of truncating. */
  wrap?: boolean;
}

export interface KeyValueProps {
  items: readonly KeyValueItem[];
  columns?: 1 | 2 | 3 | 4;
  dense?: boolean;
  className?: string;
}

const COLUMNS: Record<NonNullable<KeyValueProps['columns']>, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
};

function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === '' || value === false;
}

/** Definition list of labelled values (run metadata, tool versions, ...). */
export function KeyValue({ items, columns = 2, dense = false, className }: KeyValueProps) {
  return (
    <dl className={clsx('grid gap-x-6', COLUMNS[columns], dense ? 'gap-y-2' : 'gap-y-3.5', className)}>
      {items.map((item, index) => (
        <div key={item.key ?? index} className="min-w-0">
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd
            className={clsx(
              'mt-0.5 text-[13px] text-text',
              item.wrap ? 'whitespace-pre-wrap break-words' : 'truncate',
              item.mono && 'font-mono text-xs leading-5',
            )}
            title={item.title}
          >
            {isEmpty(item.value) ? <span className="text-subtle">—</span> : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
