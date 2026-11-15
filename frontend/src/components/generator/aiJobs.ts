/**
 * Long-running requests (AI workflows take minutes) that outlive the page component: leaving a
 * page and coming back re-attaches to the pending request and to its result instead of losing
 * them. Module-level state of this browser tab (not persisted, not shared between tabs).
 *
 * Nothing here reports server-side progress: the backend answers each workflow with one
 * response, so a job is only "running" (waiting for that response), "done" or "error".
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { isAbortError } from '../../services/api';

export type JobStatus = 'running' | 'done' | 'error';

export interface JobState<T> {
  status: JobStatus;
  /** Epoch ms when the request was sent. */
  startedAt: number;
  /** Epoch ms when the response (or the error) arrived. */
  finishedAt: number | null;
  result: T | null;
  error: unknown;
}

export type JobOutcome<T> = { ok: true; result: T } | { ok: false; error: unknown; aborted: boolean };

export class JobRegistry<T> {
  private readonly jobs = new Map<string, JobState<T>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();

  /** useSyncExternalStore subscription. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Snapshot of one job (the same object until the job changes). */
  readonly get = (key: string): JobState<T> | undefined => this.jobs.get(key);

  isRunning(key: string): boolean {
    return this.jobs.get(key)?.status === 'running';
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private put(key: string, state: JobState<T> | undefined): void {
    if (state) this.jobs.set(key, state);
    else this.jobs.delete(key);
    this.emit();
  }

  /**
   * Runs `task` as job `key`. While a job with this key is running, a second start is ignored
   * (resolves with an "aborted" outcome and leaves the running job alone). Never rejects: the
   * error is stored in the job state and returned in the outcome. A cancelled job is removed.
   */
  start(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<JobOutcome<T>> {
    if (this.isRunning(key)) {
      return Promise.resolve({ ok: false, error: new Error('A request with this key is already running.'), aborted: true });
    }
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const startedAt = Date.now();
    this.put(key, { status: 'running', startedAt, finishedAt: null, result: null, error: null });
    const isCurrent = () => this.controllers.get(key) === controller;

    return task(controller.signal).then(
      (result): JobOutcome<T> => {
        if (isCurrent()) {
          this.controllers.delete(key);
          this.put(key, { status: 'done', startedAt, finishedAt: Date.now(), result, error: null });
        }
        return { ok: true, result };
      },
      (error: unknown): JobOutcome<T> => {
        const aborted = isAbortError(error) || controller.signal.aborted;
        if (isCurrent()) {
          this.controllers.delete(key);
          if (aborted) this.put(key, undefined);
          else this.put(key, { status: 'error', startedAt, finishedAt: Date.now(), result: null, error });
        }
        return { ok: false, error, aborted };
      },
    );
  }

  /** Stops waiting for a running job (the browser request is aborted; the backend may still finish). */
  cancel(key: string): void {
    this.controllers.get(key)?.abort();
  }

  /** Forgets a job; a running one is cancelled first. */
  clear(key: string): void {
    const controller = this.controllers.get(key);
    if (controller) {
      this.controllers.delete(key);
      controller.abort();
    }
    if (this.jobs.has(key)) this.put(key, undefined);
  }

  /** Replaces the result of a finished job (e.g. to record that its patches were applied). */
  update(key: string, fn: (result: T) => T): void {
    const job = this.jobs.get(key);
    if (!job || job.status !== 'done' || job.result === null) return;
    this.put(key, { ...job, result: fn(job.result) });
  }
}

/** Live state of job `key` (undefined when there is none). */
export function useJob<T>(registry: JobRegistry<T>, key: string | null): JobState<T> | undefined {
  return useSyncExternalStore(
    registry.subscribe,
    () => (key === null ? undefined : registry.get(key)),
    () => undefined,
  );
}

/** Whole seconds elapsed since `since` (epoch ms); re-renders every second while `active`. */
export function useElapsedSeconds(since: number | null | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!since) return 0;
  return Math.max(0, Math.floor(((active ? now : Date.now()) - since) / 1000));
}

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
