import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import clsx from 'clsx';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export interface ResizeHandleProps {
  /** "x": vertical bar between columns (changes a width); "y": horizontal bar (changes a height). */
  axis: 'x' | 'y';
  value: number;
  min: number;
  max: number;
  /** +1: dragging right / down increases the value; -1: it decreases the value. */
  direction: 1 | -1;
  onChange: (value: number) => void;
  label: string;
  className?: string;
}

/** Draggable (and keyboard-adjustable) splitter between two panels. */
export function ResizeHandle({ axis, value, min, max, direction, onChange, label, className }: ResizeHandleProps) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return undefined;
    const body = document.body.style;
    const prevCursor = body.cursor;
    const prevSelect = body.userSelect;
    body.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    body.userSelect = 'none';
    return () => {
      body.cursor = prevCursor;
      body.userSelect = prevSelect;
    };
  }, [dragging, axis]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { pos: axis === 'x' ? event.clientX : event.clientY, value };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin) return;
    const pos = axis === 'x' ? event.clientX : event.clientY;
    onChange(Math.round(clamp(origin.value + direction * (pos - origin.pos), min, max)));
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    let delta = 0;
    if (axis === 'x' && event.key === 'ArrowLeft') delta = -step;
    else if (axis === 'x' && event.key === 'ArrowRight') delta = step;
    else if (axis === 'y' && event.key === 'ArrowUp') delta = -step;
    else if (axis === 'y' && event.key === 'ArrowDown') delta = step;
    if (delta === 0) return;
    event.preventDefault();
    onChange(Math.round(clamp(value + direction * delta, min, max)));
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(Math.max(min, max))}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      className={clsx(
        'group relative z-10 shrink-0 touch-none outline-none',
        axis === 'x' ? '-mx-[3px] w-[7px] cursor-col-resize' : '-my-[3px] h-[7px] cursor-row-resize',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'absolute transition-colors',
          axis === 'x' ? 'inset-y-0 left-[3px] w-px' : 'inset-x-0 top-[3px] h-px',
          dragging ? 'bg-accent' : 'bg-border group-hover:bg-accent/60 group-focus-visible:bg-accent',
        )}
      />
    </div>
  );
}

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Size of an element (client box), tracked with a ResizeObserver. Returns a callback ref, so it
 * also works for elements that mount after the component (conditional rendering).
 */
export function useElementSize<T extends HTMLElement>(): [(el: T | null) => void, ElementSize] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return undefined;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}
