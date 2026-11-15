/**
 * Editor buffers of the RTL Studio: the server content of each open file (`saved`), the editor
 * content (`value`) and conflicts with changes made elsewhere (AI patches applied in the
 * Debugger, fault injection, another browser tab). Kept in the session store, so unsaved edits
 * survive navigation between pages; a page reload asks for confirmation while edits are unsaved.
 */
import { api } from '../../services/api';
import type { ProjectFile } from '../../services/types';
import { parseServerDate } from '../../lib/format';
import { readSession, sessionKeys, useSessionState, writeSession } from './sessionStore';

export interface BufferConflict {
  /** Content currently stored on the server. */
  content: string;
  updatedAt: string | null;
}

export interface FileBuffer {
  fileId: number;
  path: string;
  /** Content of the file on the server, as last loaded or saved. */
  saved: string;
  /** Content in the editor. */
  value: string;
  /** FileMeta.updated_at that `saved` corresponds to. */
  updatedAt: string | null;
  /** The server content changed while the buffer had unsaved edits. */
  conflict: BufferConflict | null;
}

export type BufferMap = Readonly<Record<number, FileBuffer>>;
export type SavingMap = Readonly<Record<number, true>>;

const EMPTY_BUFFERS: BufferMap = Object.freeze({});
const EMPTY_SAVING: SavingMap = Object.freeze({});

export const buffersKey = (pid: number) => `studio.buffers.${pid}`;
const savingKey = (pid: number) => `studio.saving.${pid}`;

export function isDirty(buffer: FileBuffer | null | undefined): boolean {
  return Boolean(buffer && buffer.value !== buffer.saved);
}

export function readBuffers(pid: number): BufferMap {
  return readSession(buffersKey(pid), EMPTY_BUFFERS);
}

export function writeBuffers(pid: number, update: (prev: BufferMap) => BufferMap): void {
  writeSession<BufferMap>(buffersKey(pid), update, EMPTY_BUFFERS);
}

/** Updates one buffer (no-op when the buffer does not exist). */
export function patchBuffer(pid: number, fileId: number, update: (buffer: FileBuffer) => FileBuffer): void {
  writeBuffers(pid, (prev) => {
    const current = prev[fileId];
    if (!current) return prev;
    const next = update(current);
    return next === current ? prev : { ...prev, [fileId]: next };
  });
}

export function removeBuffer(pid: number, fileId: number): void {
  writeBuffers(pid, (prev) => {
    if (!(fileId in prev)) return prev;
    const next = { ...prev };
    delete next[fileId];
    return next;
  });
}

/** Replaces the buffer with the server's file (load, format, revert, fault injection). */
export function setBufferFromServer(pid: number, file: ProjectFile): void {
  writeBuffers(pid, (prev) => ({
    ...prev,
    [file.id]: {
      fileId: file.id,
      path: file.path,
      saved: file.content,
      value: file.content,
      updatedAt: file.updated_at,
      conflict: null,
    },
  }));
}

/**
 * Merges a newer server version into an existing buffer: adopted silently when the buffer has
 * no unsaved edits, recorded as a conflict otherwise.
 */
export function reconcileBuffer(pid: number, file: ProjectFile): void {
  patchBuffer(pid, file.id, (b) => {
    // A response that is older than what the buffer already knows (e.g. a GET that raced with a
    // save) must not roll the buffer back.
    const known = parseServerDate(b.updatedAt)?.getTime();
    const incoming = parseServerDate(file.updated_at)?.getTime();
    if (known !== undefined && incoming !== undefined && incoming < known) return b;
    const base = { ...b, path: file.path, updatedAt: file.updated_at };
    if (file.content === b.saved) return { ...base, conflict: null };
    if (b.value === b.saved || b.value === file.content) {
      return { ...base, saved: file.content, value: file.content, conflict: null };
    }
    return { ...base, conflict: { content: file.content, updatedAt: file.updated_at } };
  });
}

/** Resolves a conflict: keep the editor content (saving then overwrites) or load the server version. */
export function resolveConflict(pid: number, fileId: number, keep: 'mine' | 'server'): void {
  patchBuffer(pid, fileId, (b) => {
    if (!b.conflict) return b;
    if (keep === 'server') {
      return { ...b, saved: b.conflict.content, value: b.conflict.content, updatedAt: b.conflict.updatedAt, conflict: null };
    }
    return { ...b, saved: b.conflict.content, updatedAt: b.conflict.updatedAt, conflict: null };
  });
}

/** Loads a file into a new buffer (no-op if a buffer appeared meanwhile). Rejects with ApiError. */
export async function loadBuffer(pid: number, fileId: number, signal?: AbortSignal): Promise<void> {
  const file = await api.files.get(pid, fileId, { signal });
  writeBuffers(pid, (prev) =>
    prev[fileId]
      ? prev
      : {
          ...prev,
          [fileId]: {
            fileId,
            path: file.path,
            saved: file.content,
            value: file.content,
            updatedAt: file.updated_at,
            conflict: null,
          },
        },
  );
}

const inflightSaves = new Map<string, Promise<ProjectFile | null>>();

function setSaving(pid: number, fileId: number, saving: boolean): void {
  writeSession<SavingMap>(
    savingKey(pid),
    (prev) => {
      if (saving === Boolean(prev[fileId])) return prev;
      const next: Record<number, true> = { ...prev };
      if (saving) next[fileId] = true;
      else delete next[fileId];
      return next;
    },
    EMPTY_SAVING,
  );
}

/**
 * Saves a dirty buffer (PUT; the previous server content becomes a revision). Resolves with the
 * saved file, or null when there was nothing to save. Rejects with the ApiError of the request.
 * A save requested while another one runs waits for it and then saves the newer edits.
 */
export function saveBuffer(pid: number, fileId: number): Promise<ProjectFile | null> {
  const key = `${pid}:${fileId}`;
  const running = inflightSaves.get(key);
  if (running) return running.catch(() => null).then(() => saveBuffer(pid, fileId));
  const buffer = readBuffers(pid)[fileId];
  if (!buffer || buffer.value === buffer.saved) return Promise.resolve(null);
  const content = buffer.value;
  setSaving(pid, fileId, true);
  const request = api.files
    .save(pid, fileId, { content, reason: 'edit' })
    .then((file) => {
      patchBuffer(pid, fileId, (b) => ({
        ...b,
        path: file.path,
        saved: file.content,
        value: b.value === content ? file.content : b.value,
        updatedAt: file.updated_at,
        conflict: null,
      }));
      return file;
    })
    .finally(() => {
      inflightSaves.delete(key);
      setSaving(pid, fileId, false);
    });
  inflightSaves.set(key, request);
  return request;
}

/** Ids of the project's buffers with unsaved edits. */
export function dirtyFileIds(pid: number): number[] {
  return Object.values(readBuffers(pid))
    .filter((b) => b.value !== b.saved)
    .map((b) => b.fileId);
}

export function useBuffers(pid: number | null): BufferMap {
  return useSessionState<BufferMap>(buffersKey(pid ?? 0), EMPTY_BUFFERS)[0];
}

export function useSaving(pid: number | null): SavingMap {
  return useSessionState<SavingMap>(savingKey(pid ?? 0), EMPTY_SAVING)[0];
}

function anyUnsavedBuffers(): boolean {
  return sessionKeys('studio.buffers.').some((key) =>
    Object.values(readSession<BufferMap>(key, EMPTY_BUFFERS)).some((b) => b.value !== b.saved),
  );
}

// Unsaved edits live only in memory: ask before the page is reloaded or closed.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (!anyUnsavedBuffers()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
