/**
 * File-name rules and helpers of the RTL Studio. The rules mirror the backend
 * (simulation/policy.py validate_filename, services/project_service.py infer_kind) so the UI can
 * explain a problem before the request; the server stays authoritative and its error is shown
 * when it disagrees.
 */
import { Binary, FileCode2, FileCog, FlaskConical, type LucideIcon } from 'lucide-react';
import type { FileKind } from '../../services/types';
import { basename, extension } from '../../lib/format';

export const KIND_ORDER: readonly FileKind[] = ['rtl', 'tb', 'include', 'data'];

export const KIND_LABELS: Record<FileKind, string> = {
  rtl: 'RTL',
  tb: 'Testbench',
  include: 'Include',
  data: 'Data',
};

export const KIND_ICONS: Record<FileKind, LucideIcon> = {
  rtl: FileCode2,
  tb: FlaskConical,
  include: FileCog,
  data: Binary,
};

export const KIND_ICON_CLASS: Record<FileKind, string> = {
  rtl: 'text-accent',
  tb: 'text-[#c4b5fd]',
  include: 'text-[#93c5fd]',
  data: 'text-[#fbbf24]',
};

/** Extensions accepted for project files (policy.ALLOWED_EXTENSIONS). */
export const ALLOWED_EXTENSIONS = ['.v', '.sv', '.vh', '.svh', '.vlt', '.mem', '.hex', '.txt', '.dat'] as const;
/** Extensions accepted by POST /files/upload. */
export const UPLOAD_EXTENSIONS = ['.v', '.sv', '.vh', '.svh', '.hex', '.mem'] as const;
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.join(',');
const HDL_EXTENSIONS = new Set(['v', 'sv', 'vh', 'svh']);

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const TB_STEM_RE = /^(tb|testbench)$|^tb_|_tb$|^testbench_|_testbench$/i;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function normalizeKind(kind: string | null | undefined): FileKind {
  return kind === 'tb' || kind === 'include' || kind === 'data' ? kind : 'rtl';
}

/** Client-side check of a project file name; null when acceptable. */
export function validateFileName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter a file name.';
  if (/[\\/:]/.test(n)) return 'Use a plain file name without folders or drive letters.';
  if (n.includes('..')) return "'..' is not allowed in file names.";
  if (!NAME_RE.test(n)) {
    return "1-100 characters: letters, digits, '_', '.' and '-'; it must not start with '.' or '-'.";
  }
  const ext = extension(n);
  if (!ext || !(ALLOWED_EXTENSIONS as readonly string[]).includes(`.${ext}`)) {
    return `Unsupported extension${ext ? ` '.${ext}'` : ''}. Allowed: ${ALLOWED_EXTENSIONS.join(' ')}`;
  }
  return null;
}

/** Same inference as the backend: tb_x / x_tb -> tb, .vh/.svh/.vlt -> include, .hex/.mem/.txt/.dat -> data. */
export function inferKind(path: string): FileKind {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  if (ext === '.vh' || ext === '.svh' || ext === '.vlt') return 'include';
  if (ext === '.hex' || ext === '.mem' || ext === '.txt' || ext === '.dat') return 'data';
  if (TB_STEM_RE.test(stem)) return 'tb';
  return 'rtl';
}

/** Verilog / SystemVerilog source (what the formatter and the AI explainer accept). */
export function isHdlPath(path: string | null | undefined): boolean {
  return HDL_EXTENSIONS.has(extension(path));
}

export function hasUploadExtension(name: string): boolean {
  const ext = `.${extension(name)}`;
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

/** Module name derived from a file name, when it is a valid Verilog identifier. */
export function moduleNameFor(path: string): string | null {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return IDENT_RE.test(stem) ? stem : null;
}

/** Empty module skeleton for a new .v / .sv file (a starting point, not generated logic). */
export function moduleSkeleton(path: string): string | null {
  const ext = extension(path);
  if (ext !== 'v' && ext !== 'sv') return null;
  const name = moduleNameFor(path);
  if (!name) return null;
  return ['`timescale 1ns/1ps', '', `module ${name} (`, ');', '', 'endmodule', ''].join('\n');
}

/** "a.v, b.v and 3 more" */
export function listNames(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}
