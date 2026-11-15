import type { HighlightTone } from '../../editor/editorUtils';

/** A location to show in the editor (opens the file, reveals and highlights the lines). */
export interface RevealTarget {
  fileId: number;
  /** 1-based first line. */
  line: number;
  /** 1-based last line (default: `line`). */
  endLine?: number;
  /** Several line ranges to highlight (default: line..endLine); `line` is still the one revealed. */
  ranges?: ReadonlyArray<{ start: number; end: number }>;
  column?: number;
  tone?: HighlightTone;
  /** Move keyboard focus into the editor (default false). */
  focus?: boolean;
  /** Markdown hover text of the highlighted lines. */
  hover?: string;
}

/** Same as RevealTarget but addressed by file name (AI references, module locations). */
export interface RevealPathTarget extends Omit<RevealTarget, 'fileId'> {
  path: string;
}

export type RevealHandler = (target: RevealTarget) => void;
export type RevealPathHandler = (target: RevealPathTarget) => void;
