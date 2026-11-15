import { memo, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import type { FileKind } from '../../services/types';
import { KIND_ICONS, KIND_ICON_CLASS, KIND_LABELS } from './fileRules';

export interface EditorTabItem {
  id: number;
  path: string;
  kind: FileKind;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
}

export interface EditorTabsProps {
  tabs: readonly EditorTabItem[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
}

/** Open-file tabs with unsaved-change markers (VS Code style: dot that turns into a close button). */
export const EditorTabs = memo(function EditorTabs({ tabs, activeId, onSelect, onClose }: EditorTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when it changes (e.g. opened from the explorer or a problem).
  useEffect(() => {
    if (activeId === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  if (tabs.length === 0) {
    return <div className="flex h-9 shrink-0 items-center border-b border-border bg-panel/40 px-3 text-2xs text-subtle">No open files</div>;
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Open files"
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel/40 [scrollbar-width:none]"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const Icon = KIND_ICONS[tab.kind];
        const status = tab.conflict
          ? 'changed on the server while edited'
          : tab.saving
            ? 'saving'
            : tab.dirty
              ? 'unsaved changes'
              : null;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className={clsx(
              'group relative flex min-w-0 max-w-[15rem] shrink-0 items-center border-r border-border',
              active ? 'bg-surface text-text' : 'text-muted hover:bg-hover/50 hover:text-text',
            )}
          >
            {active && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={`${tab.path} (${KIND_LABELS[tab.kind]})${status ? ` - ${status}` : ''}`}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              className="flex h-full min-w-0 items-center gap-1.5 pl-3 pr-1 text-left outline-none focus-visible:bg-hover"
            >
              <Icon aria-hidden="true" className={clsx('size-3.5 shrink-0', KIND_ICON_CLASS[tab.kind])} />
              <span className={clsx('truncate font-mono text-xs', tab.conflict && 'text-[#fcd34d]')}>{tab.path}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.path}${tab.dirty ? ' (unsaved changes)' : ''}`}
              title={tab.dirty ? 'Unsaved changes - close' : 'Close'}
              onClick={() => onClose(tab.id)}
              className="relative mr-1.5 flex size-5 shrink-0 items-center justify-center rounded text-subtle hover:bg-raised hover:text-text"
            >
              {tab.dirty || tab.saving || tab.conflict ? (
                <>
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'size-2 rounded-full group-hover:hidden',
                      tab.conflict ? 'bg-warn' : tab.saving ? 'animate-pulse bg-accent' : 'bg-text/80',
                    )}
                  />
                  <X aria-hidden="true" className="hidden size-3.5 group-hover:block" />
                </>
              ) : (
                <X aria-hidden="true" className={clsx('size-3.5', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')} />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
});
