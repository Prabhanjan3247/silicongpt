/**
 * Line numbers touched by a change, used to highlight an injected fault or a revert in the
 * editor. Derived from the backend's unified diff (or from the two texts as a fallback).
 */

/** New-file line numbers to highlight for a unified diff: added lines plus deletion points. */
export function changedLinesFromUnifiedDiff(diff: string | null | undefined): number[] {
  if (!diff) return [];
  const lines = new Set<number>();
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.replace(/\r\n?/g, '\n').split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number.parseInt(header[1] ?? '0', 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+')) {
      lines.add(newLine);
      newLine += 1;
    } else if (raw.startsWith('-')) {
      lines.add(Math.max(1, newLine));
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      newLine += 1;
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/** First..last differing line of `after` compared with `before` (1-based), or null when equal. */
export function changedLineRange(before: string, after: string): { start: number; end: number } | null {
  if (before === after) return null;
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const first = start + 1;
  const last = Math.max(first, endB + 1);
  return { start: Math.min(first, b.length), end: Math.min(last, b.length) };
}

/** Collapses sorted line numbers into ranges: [3,4,5,9] -> [{3,5},{9,9}]. */
export function toRanges(lines: readonly number[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && line <= last.end + 1) last.end = Math.max(last.end, line);
    else out.push({ start: line, end: line });
  }
  return out;
}
