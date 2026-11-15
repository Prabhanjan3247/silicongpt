import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is attached to (usually the trigger button). */
  anchorRef: RefObject<HTMLElement | null>;
  align?: 'start' | 'end';
  /** Width in px (default: 300). */
  width?: number;
  /** ARIA role of the panel: "menu" (arrow-key navigation between items) or "dialog". */
  role?: 'menu' | 'dialog';
  label?: string;
  className?: string;
  children: ReactNode;
}

interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Floating panel rendered in a portal with fixed positioning (so it is not clipped by scrolling
 * containers). Closes on outside pointer-down and Escape.
 */
export function Popover({ open, onClose, anchorRef, align = 'start', width = 300, role = 'menu', label, className, children }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      let left = align === 'end' ? anchor.right - w : anchor.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      const below = vh - anchor.bottom - 12;
      const above = anchor.top - 12;
      if (below >= 220 || below >= above) {
        setPlacement({ left, top: anchor.bottom + 4, maxHeight: Math.max(120, below) });
      } else {
        setPlacement({ left, bottom: vh - anchor.top + 4, maxHeight: Math.max(120, above) });
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align, width, anchorRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCloseRef.current();
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, anchorRef]);

  // Focus the first item once the panel is placed (keyboard users land inside the menu).
  useEffect(() => {
    if (!open || !placement || role !== 'menu') return;
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    panel.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, [open, placement, role]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (role !== 'menu') return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1;
    else if (event.key === 'End') next = items.length - 1;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: placement?.left ?? -9999,
        top: placement?.top,
        bottom: placement?.bottom,
        width: Math.min(width, typeof window === 'undefined' ? width : window.innerWidth - 16),
        maxHeight: placement?.maxHeight,
        visibility: placement ? 'visible' : 'hidden',
      }}
      className={clsx(
        'z-[60] flex flex-col overflow-y-auto rounded-xl border border-border-strong bg-raised p-1 shadow-pop',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemProps {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  /** Right-aligned text (shortcut, badge). */
  hint?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}

/** Button row inside a Popover with role="menu". */
export function MenuItem({ icon, label, description, hint, onSelect, disabled = false, danger = false, title }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onSelect}
      className={clsx(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors',
        'focus-visible:bg-hover enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45',
        danger ? 'text-[#fca5a5]' : 'text-text',
      )}
    >
      {icon && (
        <span className={clsx('mt-0.5 shrink-0 [&_svg]:size-3.5', danger ? 'text-fail' : 'text-muted')}>{icon}</span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5">{label}</span>
        {description && <span className="mt-0.5 block text-2xs leading-4 text-muted">{description}</span>}
      </span>
      {hint && <span className="shrink-0 pt-0.5 text-2xs text-subtle">{hint}</span>}
    </button>
  );
}

/** Thin separator / section label inside a menu. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">{children}</p>;
}
