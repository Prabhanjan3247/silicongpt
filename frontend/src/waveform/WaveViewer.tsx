/**
 * Waveform viewer: time axis canvas + wave canvas (devicePixelRatio aware) with DOM label and
 * value columns.
 *
 * Interactions (wave area): click = primary cursor (snaps to a transition of the row within
 * 5 px), shift+click = secondary marker, drag = pan, wheel = pan, ctrl/cmd+wheel = zoom around
 * the pointer, shift+wheel = scroll the rows. Axis: click = cursor (snaps to failure markers),
 * drag = zoom to the dragged range. Keyboard (viewer focused): arrows left/right = previous/next
 * transition of the selected signal, up/down = select signal, + / - = zoom, F = fit, Esc = clear
 * marker.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import type { Radix, SignalKind, TrackData, ViewerRow, ViewRange } from './model';
import { drawAxis, drawWaves, measureCharWidth, prepareCanvas } from './renderer';
import { AXIS_HEIGHT, ROW_HEIGHT, WAVE_FONT } from './theme';
import { axisTicks, formatTime, type Timescale } from './timescale';
import {
  classifyBits,
  formatValue,
  nearestChangeTime,
  radixesFor,
  RADIX_LABELS,
  RADIX_TITLES,
  sampleTrack,
} from './values';

export const LABEL_WIDTH = 216;
export const VALUE_WIDTH = 156;

export type ViewerCommand = 'next' | 'prev' | 'zoomIn' | 'zoomOut' | 'fit' | 'up' | 'down' | 'clearMarker';

export interface WaveViewerProps {
  rows: readonly ViewerRow[];
  timescale: Timescale;
  endTime: number;
  view: ViewRange;
  /** Requested view (the caller clamps it). */
  onViewChange: (view: ViewRange) => void;
  cursor: number | null;
  onCursor: (t: number) => void;
  marker: number | null;
  onMarker: (t: number | null) => void;
  selected: string | null;
  onSelect: (name: string) => void;
  /** Times of failing checks (ascending), drawn on the axis. */
  failures: readonly number[];
  onRadix: (name: string, radix: Radix) => void;
  onRemove: (name: string) => void;
  /** Move the row at `from` to index `to` (index after removal). */
  onMove: (from: number, to: number) => void;
  /** Width of the wave area in CSS px (for zoom limits). */
  onWidth: (width: number) => void;
  onCommand: (cmd: ViewerCommand) => void;
  /** Shown in the body when there are no rows. */
  empty?: ReactNode;
}

const KEY_COMMANDS: Record<string, ViewerCommand> = {
  ArrowRight: 'next',
  ArrowLeft: 'prev',
  ArrowUp: 'up',
  ArrowDown: 'down',
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  _: 'zoomOut',
  f: 'fit',
  F: 'fit',
  Escape: 'clearMarker',
};

/** "tb.dut.u_alu.y" -> scope "dut.u_alu." + name "y" (testbench root omitted). */
function splitName(full: string, leafName: string): { scope: string; name: string } {
  const firstDot = full.indexOf('.');
  const rel = firstDot >= 0 ? full.slice(firstDot + 1) : full;
  if (rel.endsWith(leafName) && rel.length > leafName.length) {
    return { scope: rel.slice(0, rel.length - leafName.length), name: leafName };
  }
  return { scope: '', name: rel };
}

/* ------------------------------------------------------------------ label row */

interface LabelRowProps {
  index: number;
  count: number;
  fullName: string;
  leafName: string;
  width: number;
  type: string;
  clock: boolean;
  selected: boolean;
  onSelect: (name: string) => void;
  onRemove: (name: string) => void;
  onMove: (from: number, to: number) => void;
  onDragStart: (index: number, e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (index: number, e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

const LabelRow = memo(function LabelRow({
  index,
  count,
  fullName,
  leafName,
  width,
  type,
  clock,
  selected,
  onSelect,
  onRemove,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: LabelRowProps) {
  const { scope, name } = splitName(fullName, leafName);
  const iconBtn =
    'inline-flex size-5 items-center justify-center rounded text-subtle hover:bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-30';
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(index, e)}
      onDragOver={(e) => onDragOver(index, e)}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(fullName)}
      title={`${fullName}\n${width} bit${width === 1 ? '' : 's'} · ${type}${clock ? ' · clock' : ''}`}
      className={clsx(
        'group flex cursor-default items-center gap-1 border-b border-border/70 pl-0.5 pr-1',
        selected ? 'bg-accent/10' : index % 2 === 1 && 'bg-white/[0.018]',
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <GripVertical aria-hidden="true" className="size-3.5 shrink-0 cursor-grab text-subtle/70 group-hover:text-muted" />
      {clock && (
        <span className="shrink-0 rounded bg-accent/15 px-1 font-mono text-[9.5px] font-semibold uppercase leading-4 text-accent">
          clk
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-baseline font-mono text-[11.5px] leading-4">
        {scope && <span className="min-w-0 shrink truncate text-subtle">{scope}</span>}
        <span className={clsx('truncate', selected ? 'font-semibold text-accent' : 'text-text')}>{name}</span>
      </span>
      {width > 1 && <span className="shrink-0 font-mono text-[10px] text-subtle">{width}b</span>}
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          className={iconBtn}
          disabled={index === 0}
          onClick={(e) => {
            e.stopPropagation();
            onMove(index, index - 1);
          }}
          aria-label={`Move ${fullName} up`}
          title="Move up"
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={index === count - 1}
          onClick={(e) => {
            e.stopPropagation();
            onMove(index, index + 1);
          }}
          aria-label={`Move ${fullName} down`}
          title="Move down"
        >
          <ArrowDown className="size-3" />
        </button>
        <button
          type="button"
          className={clsx(iconBtn, 'hover:text-fail')}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(fullName);
          }}
          aria-label={`Remove ${fullName} from the viewer`}
          title="Remove from viewer"
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  );
});

/* ------------------------------------------------------------------ value cell */

interface ValueCellProps {
  index: number;
  fullName: string;
  track: TrackData | undefined;
  width: number;
  kind: SignalKind;
  radix: Radix;
  cursor: number | null;
  selected: boolean;
  onRadix: (name: string, radix: Radix) => void;
}

const ValueCell = memo(function ValueCell({
  index,
  fullName,
  track,
  width,
  kind,
  radix,
  cursor,
  selected,
  onRadix,
}: ValueCellProps) {
  const radixes = radixesFor(width, kind);
  let text = '—';
  let tone = 'text-subtle';
  let title = 'Place the cursor (click in the waveform) to read values';
  if (cursor !== null) {
    if (!track) {
      text = '…';
      title = 'Loading';
    } else {
      const s = sampleTrack(track, cursor);
      if (s.state === 'unloaded') {
        text = 'not loaded';
        title = 'The cursor is outside the loaded time range of this signal';
      } else if (s.state === 'none') {
        text = 'no value';
        title = 'The signal has no recorded value at the cursor time';
      } else {
        text = formatValue(s.value, width, radix, kind);
        const cls = kind === 'logic' ? classifyBits(s.value) : 'known';
        tone = cls === 'known' ? 'text-text' : cls === 'z' || cls === 'zpart' ? 'text-zstate' : 'text-xstate';
        title = `${fullName} = ${text}${width > 1 && kind === 'logic' ? `\nbinary: ${s.value}` : ''}`;
      }
    }
  }
  return (
    <div
      className={clsx(
        'flex items-center gap-1 border-b border-border/70 px-1.5',
        selected ? 'bg-accent/10' : index % 2 === 1 && 'bg-white/[0.018]',
      )}
      style={{ height: ROW_HEIGHT }}
    >
      {radixes.length > 0 && (
        <select
          name={`radix:${fullName}`}
          value={radix}
          onChange={(e) => onRadix(fullName, e.target.value as Radix)}
          aria-label={`Radix of ${fullName}`}
          title={RADIX_TITLES[radix]}
          className="h-[18px] shrink-0 cursor-pointer rounded border border-border-strong bg-surface px-0.5 font-mono text-[10px] text-muted hover:border-[#36486a] focus:border-accent/60 focus:outline-none"
        >
          {radixes.map((r) => (
            <option key={r} value={r}>
              {RADIX_LABELS[r]}
            </option>
          ))}
        </select>
      )}
      <span className={clsx('min-w-0 flex-1 truncate text-right font-mono text-[11.5px]', tone)} title={title}>
        {text}
      </span>
    </div>
  );
});

/* ------------------------------------------------------------------ viewer */

interface DragState {
  id: number;
  x0: number;
  start: number;
  span: number;
  moved: boolean;
  shift: boolean;
}

export function WaveViewer(props: WaveViewerProps) {
  const { rows, cursor, selected, empty } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const waveHostRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const axisRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, viewport: 0 });
  const canvasHeight = Math.max(0, size.viewport - AXIS_HEIGHT);
  const bodyHeight = Math.max(rows.length * ROW_HEIGHT, canvasHeight);

  const latest = useRef({ props, size, canvasHeight });
  latest.current = { props, size, canvasHeight };
  const hoverX = useRef<number | null>(null);
  const drag = useRef<DragState | null>(null);
  const axisDrag = useRef<{ id: number; x0: number; x1: number } | null>(null);
  const charWidth = useRef(0);
  const raf = useRef(0);

  const draw = useCallback(() => {
    const { props: p, size: sz, canvasHeight: ch } = latest.current;
    const wave = waveRef.current;
    const axis = axisRef.current;
    const W = sz.width;
    if (!wave || !axis || W <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const ticks = axisTicks(p.view.start, p.view.span, W, p.timescale);
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    const hx = drag.current?.moved ? null : hoverX.current;
    if (ch > 0) {
      const ws = prepareCanvas(wave, W, ch, dpr);
      if (ws) {
        if (!charWidth.current) charWidth.current = measureCharWidth(ws.ctx, WAVE_FONT);
        drawWaves(ws, {
          rows: p.rows,
          selected: p.selected,
          rowHeight: ROW_HEIGHT,
          scrollTop,
          viewStart: p.view.start,
          viewSpan: p.view.span,
          endTime: p.endTime,
          gridTimes: ticks.ticks,
          cursor: p.cursor,
          marker: p.marker,
          hoverX: hx,
          charWidth: charWidth.current,
        });
      }
    }
    const as = prepareCanvas(axis, W, AXIS_HEIGHT, dpr);
    if (as) {
      const sel = axisDrag.current;
      drawAxis(as, {
        viewStart: p.view.start,
        viewSpan: p.view.span,
        endTime: p.endTime,
        timescale: p.timescale,
        ticks,
        cursor: p.cursor,
        marker: p.marker,
        hoverX: hx,
        failures: p.failures,
        selection: sel && Math.abs(sel.x1 - sel.x0) > 4 ? [sel.x0, sel.x1] : null,
      });
    }
  }, []);

  const requestDraw = useCallback(() => {
    if (raf.current) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = 0;
      draw();
    });
  }, [draw]);

  // Redraw after every render (props or size changed).
  useEffect(() => {
    requestDraw();
  });

  useEffect(
    () => () => {
      // Reset as well as cancel: React StrictMode runs this cleanup on a simulated unmount and
      // then re-mounts with the same refs; a stale non-zero id would block every later draw.
      if (raf.current) window.cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  // Sizes.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const host = waveHostRef.current;
    if (!scroller || !host) return undefined;
    const update = () =>
      setSize((prev) => {
        const width = host.clientWidth;
        const viewport = scroller.clientHeight;
        return prev.width === width && prev.viewport === viewport ? prev : { width, viewport };
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scroller);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const { onWidth } = props;
  useEffect(() => {
    if (size.width > 0) onWidth(size.width);
  }, [size.width, onWidth]);

  // devicePixelRatio changes (moving the window to another monitor, browser zoom).
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    const arm = () => {
      mq?.removeEventListener('change', onChange);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onChange);
    };
    const onChange = () => {
      arm();
      requestDraw();
    };
    arm();
    return () => mq?.removeEventListener('change', onChange);
  }, [requestDraw]);

  // Web fonts: re-measure the value font once JetBrains Mono is available.
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return undefined;
    let alive = true;
    const refresh = () => {
      if (!alive) return;
      charWidth.current = 0;
      requestDraw();
    };
    void fonts.ready.then(refresh);
    fonts.addEventListener('loadingdone', refresh);
    return () => {
      alive = false;
      fonts.removeEventListener('loadingdone', refresh);
    };
  }, [requestDraw]);

  // Keep the selected row visible (keyboard selection).
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc || !selected) return;
    const idx = latest.current.props.rows.findIndex((r) => r.info.full_name === selected);
    if (idx < 0) return;
    const top = idx * ROW_HEIGHT;
    const visible = sc.clientHeight - AXIS_HEIGHT;
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + ROW_HEIGHT > sc.scrollTop + visible) sc.scrollTop = top + ROW_HEIGHT - visible;
  }, [selected]);

  // Wheel: native listener because React's wheel listeners are passive (no preventDefault).
  useEffect(() => {
    const el = waveRef.current;
    const scroller = scrollerRef.current;
    if (!el || !scroller) return undefined;
    const onWheel = (e: WheelEvent) => {
      const { props: p, size: sz } = latest.current;
      const W = sz.width;
      if (W <= 0) return;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dx = e.deltaX * scale;
      const dy = e.deltaY * scale;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const x = e.clientX - el.getBoundingClientRect().left;
        const factor = Math.exp(Math.max(-600, Math.min(600, dy || dx)) * 0.0015);
        const anchor = p.view.start + (x / W) * p.view.span;
        p.onViewChange({ start: anchor - (anchor - p.view.start) * factor, span: p.view.span * factor });
        return;
      }
      if (e.shiftKey) {
        // Browsers report Shift+wheel as horizontal scrolling: use it to scroll the rows.
        e.preventDefault();
        scroller.scrollTop += dy || dx;
        return;
      }
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      if (!delta) return;
      e.preventDefault();
      p.onViewChange({ start: p.view.start + (delta / W) * p.view.span, span: p.view.span });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------------- wave pointer handling */

  const localX = (e: { clientX: number; currentTarget: Element }) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const capture = (el: Element, pointerId: number) => {
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* the pointer is no longer active: dragging still works while it stays over the canvas */
    }
  };

  const onWaveDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const p = latest.current.props;
    drag.current = { id: e.pointerId, x0: localX(e), start: p.view.start, span: p.view.span, moved: false, shift: e.shiftKey };
    capture(e.currentTarget, e.pointerId);
    scrollerRef.current?.focus({ preventScroll: true });
  };

  const onWaveMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    const d = drag.current;
    const W = latest.current.size.width;
    if (d && d.id === e.pointerId && W > 0) {
      const dx = x - d.x0;
      if (!d.moved && Math.abs(dx) > 3) d.moved = true;
      if (d.moved) {
        latest.current.props.onViewChange({ start: d.start - (dx / W) * d.span, span: d.span });
        return;
      }
    }
    hoverX.current = x;
    requestDraw();
  };

  const onWaveUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d || d.id !== e.pointerId || d.moved) {
      requestDraw();
      return;
    }
    const { props: p, size: sz } = latest.current;
    if (sz.width <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const k = sz.width / p.view.span;
    const t = p.view.start + x / k;
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    const row = p.rows[Math.floor((y + scrollTop) / ROW_HEIGHT)];
    let time = Math.round(t);
    if (row) {
      p.onSelect(row.info.full_name);
      if (row.track) {
        const snap = nearestChangeTime(row.track, t, 5 / k);
        if (snap !== null) time = snap;
      }
    }
    time = Math.min(Math.max(0, time), Math.max(0, p.endTime));
    if (d.shift || e.shiftKey) p.onMarker(time);
    else p.onCursor(time);
  };

  const onLeave = () => {
    if (drag.current || axisDrag.current) return;
    hoverX.current = null;
    requestDraw();
  };

  /* ---------------- axis pointer handling */

  const onAxisDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const x = localX(e);
    axisDrag.current = { id: e.pointerId, x0: x, x1: x };
    capture(e.currentTarget, e.pointerId);
  };

  const onAxisMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    const a = axisDrag.current;
    if (a && a.id === e.pointerId) a.x1 = x;
    hoverX.current = x;
    requestDraw();
  };

  const onAxisUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const a = axisDrag.current;
    axisDrag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const { props: p, size: sz } = latest.current;
    if (!a || a.id !== e.pointerId || sz.width <= 0) {
      requestDraw();
      return;
    }
    const k = sz.width / p.view.span;
    const toTime = (x: number) => p.view.start + x / k;
    if (Math.abs(a.x1 - a.x0) > 4) {
      const t0 = toTime(Math.min(a.x0, a.x1));
      const t1 = toTime(Math.max(a.x0, a.x1));
      p.onViewChange({ start: t0, span: Math.max(t1 - t0, 1e-9) });
      return;
    }
    const t = toTime(a.x1);
    let time = Math.round(t);
    let best = 6 / k;
    for (const f of p.failures) {
      const dist = Math.abs(f - t);
      if (dist <= best) {
        best = dist;
        time = f;
      }
    }
    p.onCursor(Math.min(Math.max(0, time), Math.max(0, p.endTime)));
  };

  /* ---------------- keyboard */

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && target.closest('select, input, textarea, button')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cmd = KEY_COMMANDS[e.key];
    if (!cmd) return;
    e.preventDefault();
    latest.current.props.onCommand(cmd);
  };

  /* ---------------- rows (drag and drop reorder) */

  const dragFrom = useRef<number | null>(null);
  const dropAtRef = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const onRowDragStart = useCallback((index: number, e: DragEvent<HTMLDivElement>) => {
    dragFrom.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', latest.current.props.rows[index]?.info.full_name ?? '');
  }, []);

  const onRowDragOver = useCallback((index: number, e: DragEvent<HTMLDivElement>) => {
    if (dragFrom.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const at = e.clientY > rect.top + rect.height / 2 ? index + 1 : index;
    if (dropAtRef.current !== at) {
      dropAtRef.current = at;
      setDropAt(at);
    }
  }, []);

  const finishDrag = useCallback(() => {
    dragFrom.current = null;
    dropAtRef.current = null;
    setDropAt(null);
  }, []);

  const onRowDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const from = dragFrom.current;
      const at = dropAtRef.current;
      finishDrag();
      if (from === null || at === null) return;
      const to = at > from ? at - 1 : at;
      if (to !== from) latest.current.props.onMove(from, to);
    },
    [finishDrag],
  );

  // Stable callbacks for memoized rows.
  const onSelectRow = useCallback((name: string) => latest.current.props.onSelect(name), []);
  const onRemoveRow = useCallback((name: string) => latest.current.props.onRemove(name), []);
  const onMoveRow = useCallback((from: number, to: number) => latest.current.props.onMove(from, to), []);
  const onRadixRow = useCallback((name: string, radix: Radix) => latest.current.props.onRadix(name, radix), []);

  const visibleLabel =
    rows.length === 0
      ? 'No signals'
      : `${rows.length} signal${rows.length === 1 ? '' : 's'} from ${formatTime(props.view.start, props.timescale)} to ${formatTime(
          props.view.start + props.view.span,
          props.timescale,
        )}`;

  return (
    <div
      ref={scrollerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={requestDraw}
      aria-label="Waveform viewer. Arrow keys: previous/next transition and signal selection, plus/minus: zoom, F: fit."
      className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-surface focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent/60"
    >
      <div className="sticky top-0 z-20 flex border-b border-border bg-panel" style={{ height: AXIS_HEIGHT }}>
        <div
          className="flex shrink-0 items-end border-r border-border px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle"
          style={{ width: LABEL_WIDTH }}
        >
          Signal
        </div>
        <div
          className="flex shrink-0 items-end justify-end border-r border-border px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle"
          style={{ width: VALUE_WIDTH }}
          title={cursor !== null ? `Values at the cursor: ${formatTime(cursor, props.timescale)}` : 'No cursor placed'}
        >
          {cursor !== null ? `@ ${formatTime(cursor, props.timescale)}` : 'Value @ cursor'}
        </div>
        <div className="relative min-w-0 flex-1">
          <canvas
            ref={axisRef}
            className="absolute inset-0 block size-full cursor-crosshair touch-none"
            onPointerDown={onAxisDown}
            onPointerMove={onAxisMove}
            onPointerUp={onAxisUp}
            onPointerCancel={onAxisUp}
            onPointerLeave={onLeave}
            aria-label="Time axis: click to place the cursor, drag to zoom to a range"
            role="img"
          />
        </div>
      </div>
      <div className="flex" style={{ height: bodyHeight }}>
        <div className="relative shrink-0 border-r border-border" style={{ width: LABEL_WIDTH }}>
          {rows.map((r, i) => (
            <LabelRow
              key={r.info.full_name}
              index={i}
              count={rows.length}
              fullName={r.info.full_name}
              leafName={r.info.name}
              width={r.info.width}
              type={r.info.type}
              clock={r.clock}
              selected={r.info.full_name === selected}
              onSelect={onSelectRow}
              onRemove={onRemoveRow}
              onMove={onMoveRow}
              onDragStart={onRowDragStart}
              onDragOver={onRowDragOver}
              onDrop={onRowDrop}
              onDragEnd={finishDrag}
            />
          ))}
          {dropAt !== null && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 h-0.5 bg-accent"
              style={{ top: Math.max(0, dropAt * ROW_HEIGHT - 1) }}
            />
          )}
        </div>
        <div className="shrink-0 border-r border-border" style={{ width: VALUE_WIDTH }}>
          {rows.map((r, i) => (
            <ValueCell
              key={r.info.full_name}
              index={i}
              fullName={r.info.full_name}
              track={r.track}
              width={r.info.width}
              kind={r.kind}
              radix={r.radix}
              cursor={cursor}
              selected={r.info.full_name === selected}
              onRadix={onRadixRow}
            />
          ))}
        </div>
        <div ref={waveHostRef} className="relative min-w-0 flex-1">
          <canvas
            ref={waveRef}
            className="sticky block w-full cursor-crosshair touch-none"
            style={{ top: AXIS_HEIGHT, height: canvasHeight }}
            onPointerDown={onWaveDown}
            onPointerMove={onWaveMove}
            onPointerUp={onWaveUp}
            onPointerCancel={onWaveUp}
            onPointerLeave={onLeave}
            role="img"
            aria-label={visibleLabel}
          />
          {rows.length === 0 && empty && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-8" style={{ top: 0 }}>
              <div className="pointer-events-auto max-w-md">{empty}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
