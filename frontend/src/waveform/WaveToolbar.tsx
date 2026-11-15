/**
 * Waveform toolbar: zoom, transition / failure navigation, go-to-time and cursor readouts.
 * Every control acts on the loaded VCD data; nothing here is decorative.
 */
import { useState, type FormEvent } from 'react';
import clsx from 'clsx';
import {
  ChevronFirst,
  ChevronLast,
  CircleX,
  Crosshair,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import type { ViewRange } from './model';
import { formatTime, parseTimeInput, type Timescale } from './timescale';

export interface WaveToolbarProps {
  timescale: Timescale;
  endTime: number;
  view: ViewRange;
  cursor: number | null;
  marker: number | null;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Zoom to the range between cursor and marker. */
  onZoomToMarkers: () => void;
  /** Leaf name of the signal used for transition jumps (null = none selected). */
  selectedLabel: string | null;
  onPrevTransition: () => void;
  onNextTransition: () => void;
  failureCount: number;
  onPrevFailure: () => void;
  onNextFailure: () => void;
  onGoTo: (t: number) => void;
  onClearMarker: () => void;
  browserOpen: boolean;
  onToggleBrowser: () => void;
}

/**
 * Icon-only buttons: the shared Button appends `px-0` next to the size's `px-2.5`, and the latter
 * wins in the generated CSS (icons get an 8 px content box). Force the zero padding here.
 */
export const ICON_FIX = 'px-0!';

function Divider() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

export function WaveToolbar(p: WaveToolbarProps) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const ts = p.timescale;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = parseTimeInput(text, ts);
    if (t === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    p.onGoTo(Math.min(Math.max(0, t), p.endTime));
  };

  const delta = p.cursor !== null && p.marker !== null ? p.cursor - p.marker : null;
  const transitionHint = p.selectedLabel ? ` of ${p.selectedLabel}` : ' (select a signal first)';

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-panel/85 px-2 py-1.5">
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        className={ICON_FIX}
        icon={p.browserOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
        onClick={p.onToggleBrowser}
        aria-label={p.browserOpen ? 'Hide signal browser' : 'Show signal browser'}
        title={p.browserOpen ? 'Hide signal browser' : 'Show signal browser'}
      />
      <Divider />
      <Button size="sm" variant="ghost" iconOnly className={ICON_FIX} icon={<ZoomOut />} onClick={p.onZoomOut} disabled={!p.canZoomOut} aria-label="Zoom out" title="Zoom out (-)" />
      <Button size="sm" variant="ghost" iconOnly className={ICON_FIX} icon={<ZoomIn />} onClick={p.onZoomIn} disabled={!p.canZoomIn} aria-label="Zoom in" title="Zoom in (+)" />
      <Button size="sm" variant="ghost" iconOnly className={ICON_FIX} icon={<Maximize2 />} onClick={p.onFit} aria-label="Zoom to fit" title="Zoom to fit the whole dump (F)" />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        className={ICON_FIX}
        icon={<ScanSearch />}
        onClick={p.onZoomToMarkers}
        disabled={delta === null || delta === 0}
        aria-label="Zoom to cursor and marker"
        title="Zoom to the range between cursor and marker"
      />
      <Divider />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        className={ICON_FIX}
        icon={<ChevronFirst />}
        onClick={p.onPrevTransition}
        disabled={!p.selectedLabel}
        aria-label={`Previous transition${transitionHint}`}
        title={`Previous transition${transitionHint} (Left arrow)`}
      />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        className={ICON_FIX}
        icon={<ChevronLast />}
        onClick={p.onNextTransition}
        disabled={!p.selectedLabel}
        aria-label={`Next transition${transitionHint}`}
        title={`Next transition${transitionHint} (Right arrow)`}
      />
      {p.failureCount > 0 && (
        <>
          <Divider />
          <span className="inline-flex items-center gap-1 pl-0.5 text-2xs font-medium text-[#f87171]" title="Failing [SGPT] CHECK records of this run (red marks on the time axis)">
            <CircleX className="size-3.5" aria-hidden="true" />
            {p.failureCount}
          </span>
          <Button size="sm" variant="ghost" iconOnly className={ICON_FIX} icon={<SkipBack />} onClick={p.onPrevFailure} aria-label="Previous failing check" title="Previous failing check" />
          <Button size="sm" variant="ghost" iconOnly className={ICON_FIX} icon={<SkipForward />} onClick={p.onNextFailure} aria-label="Next failing check" title="Next failing check" />
        </>
      )}
      <Divider />
      <form onSubmit={submit} className="flex items-center gap-1">
        <label className="sr-only" htmlFor="sgpt-wave-goto">
          Go to time
        </label>
        <input
          id="sgpt-wave-goto"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (invalid) setInvalid(false);
          }}
          placeholder={ts.known ? 'Go to: 125 ns or 125000' : 'Go to time'}
          aria-invalid={invalid || undefined}
          title={
            invalid
              ? ts.known
                ? `Enter a number in VCD units (${ts.raw}) or a time with a unit (fs, ps, ns, us, ms, s)`
                : 'Enter a number (the VCD has no timescale)'
              : `Plain numbers are VCD units (${ts.raw}); units fs, ps, ns, us, ms, s are converted`
          }
          className={clsx(
            'h-7 w-40 rounded-md border bg-surface px-2 font-mono text-xs text-text placeholder:text-subtle focus:outline-none focus:ring-2',
            invalid ? 'border-fail/60 focus:ring-fail/15' : 'border-border-strong focus:border-accent/60 focus:ring-accent/15',
          )}
        />
        <Button type="submit" size="sm" variant="secondary" icon={<Crosshair />} disabled={!text.trim()}>
          Go
        </Button>
      </form>
      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-2 font-mono text-[11px]">
        <span title="Primary cursor (click)" className="text-[#fde047]">
          C {formatTime(p.cursor, ts)}
        </span>
        <span title="Secondary marker (shift+click)" className="inline-flex items-center gap-1 text-[#f472b6]">
          M {formatTime(p.marker, ts)}
          {p.marker !== null && (
            <button
              type="button"
              onClick={p.onClearMarker}
              className="rounded px-1 text-[10px] text-subtle hover:bg-hover hover:text-text"
              aria-label="Clear marker"
              title="Clear marker (Esc)"
            >
              ×
            </button>
          )}
        </span>
        <span title="Cursor minus marker" className="text-text">
          Δ {delta === null ? '—' : formatTime(delta, ts)}
        </span>
        <span className="text-subtle" title={`Visible range · timescale ${ts.raw}`}>
          {formatTime(p.view.start, ts)} – {formatTime(p.view.start + p.view.span, ts)}
        </span>
      </div>
    </div>
  );
}
