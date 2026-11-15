import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Bug, FileDiff, RefreshCw, Stethoscope } from 'lucide-react';
import { api, isAbortError } from '../../services/api';
import type { AIInteractionDetail, AIRecord, RunDetail, RunSummary } from '../../services/types';
import { formatDateTime, formatNumber, formatRelative } from '../../lib/format';
import { runPaths } from '../run/RunLinks';
import { Badge, Button, ButtonLink, EmptyState, ErrorBanner, LoadingState, Markdown, StatusBadge } from '../ui';
import { InteractionMeta } from './aiShared';
import type { RevealPathHandler } from './types';

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asStrings = (v: unknown): string[] => asArray(v).filter((x): x is string => typeof x === 'string' && x.trim() !== '');

/** The debugger output inside a stored response ({diagnosis}, {result}, {data} or the object itself). */
function findDiagnosis(resp: Json | null): Json | null {
  if (!resp) return null;
  for (const candidate of [resp.diagnosis, resp.result, resp.data, resp]) {
    const rec = asRecord(candidate);
    if (rec && ('root_cause' in rec || 'failing_operation' in rec)) return rec;
  }
  return null;
}

interface PatchView {
  path: string;
  diff: string | null;
  added: number | null;
  removed: number | null;
}

function findPatches(resp: Json | null, diagnosis: Json | null): PatchView[] {
  const patches = asArray(resp?.patches)
    .map(asRecord)
    .filter((p): p is Json => p !== null);
  if (patches.length > 0) {
    return patches.map((p) => {
      const stats = asRecord(p.stats);
      return { path: asString(p.path) ?? '(unnamed file)', diff: asString(p.diff), added: asNumber(stats?.added), removed: asNumber(stats?.removed) };
    });
  }
  return asArray(diagnosis?.patched_files)
    .map(asRecord)
    .filter((p): p is Json => p !== null)
    .map((p) => ({ path: asString(p.path) ?? '(unnamed file)', diff: null, added: null, removed: null }));
}

interface SessionView {
  record: AIRecord;
  detail: AIInteractionDetail | null;
  detailError: unknown;
  applied: { at: string | null; how: string } | null;
  /** A newer debugging attempt that failed (the AI service records failed attempts too). */
  failedNewer: { id: number; createdAt: string; error: string | null } | null;
}

/** AIRecord as sent by the AI service, which adds {status: "ok" | "error", error}. */
type RecordWithStatus = AIRecord & { status?: string; error?: string | null };

const isDebugRecord = (r: AIRecord) => r.agent === 'debugger' && !/apply/i.test(r.action ?? '');
const isApplyRecord = (r: AIRecord) => r.agent === 'debugger' && /apply/i.test(r.action ?? '');
const isFailed = (r: AIRecord) => (r as RecordWithStatus).status === 'error';

async function loadSession(projectId: number, signal: AbortSignal): Promise<SessionView | null> {
  const history = await api.ai.history(projectId, { signal });
  const sorted = [...history].sort((a, b) => b.id - a.id);
  const debugRecords = sorted.filter(isDebugRecord);
  const record = debugRecords.find((r) => !isFailed(r)) ?? debugRecords[0];
  if (!record) return null;
  const newestFailed = debugRecords.find((r) => isFailed(r) && r.id > record.id) as RecordWithStatus | undefined;
  const failedNewer = newestFailed
    ? { id: newestFailed.id, createdAt: newestFailed.created_at, error: newestFailed.error ?? null }
    : null;
  let detail: AIInteractionDetail | null = null;
  let detailError: unknown = null;
  try {
    detail = await api.ai.interaction(record.id, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    detailError = err;
  }
  // Was the fix applied? Either recorded on the session itself, or by a later "apply" record that
  // references this session (both are written by the AI service).
  let applied: SessionView['applied'] = null;
  const resp = asRecord(detail?.response);
  if (resp && (resp.applied || resp.applied_paths || resp.applied_at)) {
    applied = { at: asString(resp.applied_at), how: 'recorded on this debugging session' };
  } else {
    const applyRecords = sorted.filter((r) => isApplyRecord(r) && r.id > record.id).slice(0, 3);
    for (const r of applyRecords) {
      try {
        const d = await api.ai.interaction(r.id, { signal });
        if (asNumber(asRecord(d.request)?.interaction_id) === record.id) {
          applied = { at: r.created_at, how: `apply record #${r.id}` };
          break;
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
      }
    }
  }
  return { record, detail, detailError, applied, failedNewer };
}

export interface FixesTabProps {
  projectId: number;
  lastRun: RunSummary | RunDetail | null;
  onRevealPath: RevealPathHandler;
}

/** Latest AI debugger interaction of the project (diagnosis, patches, validation) with a Debugger link. */
export function FixesTab({ projectId, lastRun, onRevealPath }: FixesTabProps) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadSession(projectId, controller.signal)
      .then((s) => setSession(s))
      .catch((err) => {
        if (!isAbortError(err)) {
          setSession(null);
          setError(err);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const view = useMemo(() => {
    if (!session) return null;
    const resp = asRecord(session.detail?.response);
    const diagnosis = findDiagnosis(resp);
    const validation = asRecord(resp?.validation);
    return {
      diagnosis,
      error: asString(resp?.error),
      notes: asStrings(resp?.notes),
      patches: findPatches(resp, diagnosis),
      validation: validation
        ? {
            id: asNumber(validation.id),
            status: asString(validation.status),
            passed: asNumber(validation.tests_passed),
            total: asNumber(validation.tests_total),
          }
        : null,
    };
  }, [session]);

  const header = (
    <div className="flex items-center gap-2">
      <Stethoscope className="size-3.5 text-subtle" aria-hidden="true" />
      <h4 className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Latest AI debugging session</h4>
      <Button size="xs" variant="ghost" iconOnly icon={<RefreshCw />} aria-label="Reload" title="Reload" onClick={reload} disabled={loading} />
    </div>
  );

  if (loading && !session) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <LoadingState label="Loading AI history…" minHeight="8rem" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <ErrorBanner error={error} title="Could not load the AI history" onRetry={reload} />
      </div>
    );
  }
  if (!session || !view) {
    const failedRun = lastRun && lastRun.status === 'failed' ? lastRun : null;
    return (
      <div className="flex flex-col gap-2">
        {header}
        <EmptyState
          compact
          icon={<Bug />}
          title="No AI debugging session yet"
          description="The Debugger diagnoses a failing run from its checks, logs and waveform samples, proposes a patch and pre-validates it with a real simulation."
          action={
            failedRun ? (
              <ButtonLink to={runPaths(failedRun.id).debugger} size="sm" variant="danger" icon={<Bug />}>
                Debug run #{failedRun.id}
              </ButtonLink>
            ) : (
              <ButtonLink to="/debugger" size="sm" icon={<Bug />}>
                Open the Debugger
              </ButtonLink>
            )
          }
        />
      </div>
    );
  }

  const { record } = session;
  const d = view.diagnosis;
  const confidence = asString(d?.confidence);
  const suspectedFile = asString(d?.suspected_file);
  const suspectedLines = asArray(d?.suspected_lines).filter((n): n is number => typeof n === 'number' && n > 0);
  const evidence = asStrings(d?.evidence);
  const alternatives = asStrings(d?.alternative_hypotheses);
  const debuggerLink = record.run_id !== null ? runPaths(record.run_id).debugger : '/debugger';

  return (
    <div className="flex flex-col gap-3">
      {header}
      <div className="flex flex-wrap items-center gap-2 text-2xs text-subtle">
        <span title={formatDateTime(record.created_at)}>{formatRelative(record.created_at)}</span>
        {record.run_id !== null && <span>· failing run #{record.run_id}</span>}
        {session.applied ? (
          <Badge tone="pass" size="xs" title={`Applied (${session.applied.how})`}>
            patch applied{session.applied.at ? ` ${formatRelative(session.applied.at)}` : ''}
          </Badge>
        ) : view.patches.length > 0 ? (
          <Badge tone="neutral" size="xs">
            patch not applied
          </Badge>
        ) : null}
      </div>

      {session.detailError ? <ErrorBanner error={session.detailError} title="Could not load the session details" /> : null}
      {view.error && <ErrorBanner error={view.error} title="This debugging attempt failed" />}
      {session.failedNewer && (
        <p className="rounded-lg border border-warn/30 bg-warn/[0.06] px-2.5 py-2 text-2xs leading-4 text-[#efd9a8]">
          A newer attempt (record #{session.failedNewer.id}, {formatRelative(session.failedNewer.createdAt)}) failed
          {session.failedNewer.error ? `: ${session.failedNewer.error}` : '.'}
        </p>
      )}

      {d ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface/60 p-3">
          {asString(d.failing_operation) && <p className="text-xs font-medium text-text">{asString(d.failing_operation)}</p>}
          {(asString(d.expected) || asString(d.actual)) && (
            <div className="grid grid-cols-2 gap-2 font-mono text-2xs">
              <div className="rounded-md bg-raised px-2 py-1">
                <span className="block font-sans text-subtle">expected</span>
                <span className="text-[#c3cede]">{asString(d.expected) ?? '-'}</span>
              </div>
              <div className="rounded-md bg-raised px-2 py-1">
                <span className="block font-sans text-subtle">actual</span>
                <span className="text-[#f87171]">{asString(d.actual) ?? '-'}</span>
              </div>
            </div>
          )}
          {asString(d.root_cause) && (
            <div>
              <p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Root cause</p>
              <Markdown compact source={asString(d.root_cause)} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {confidence && (
              <Badge tone={confidence === 'high' ? 'pass' : confidence === 'medium' ? 'blue' : 'warn'} size="xs">
                {confidence} confidence
              </Badge>
            )}
            {suspectedFile && (
              <button
                type="button"
                onClick={() =>
                  onRevealPath({
                    path: suspectedFile,
                    line: suspectedLines[0] ?? 1,
                    endLine: suspectedLines.length > 0 ? Math.max(...suspectedLines) : undefined,
                    tone: 'error',
                    hover: 'Suspected by the AI debugger',
                  })
                }
                className="rounded-md font-mono text-2xs text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                title="Show the suspected lines in the editor"
              >
                {suspectedFile}
                {suspectedLines.length > 0 ? `:${suspectedLines.join(',')}` : ''}
              </button>
            )}
          </div>
          {asString(d.fix_explanation) && (
            <div>
              <p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Proposed fix</p>
              <Markdown compact source={asString(d.fix_explanation)} />
            </div>
          )}
          {evidence.length > 0 && (
            <details className="text-xs text-[#c3cede]">
              <summary className="cursor-pointer text-2xs text-muted">Evidence ({evidence.length})</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 marker:text-subtle">
                {evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          {alternatives.length > 0 && (
            <details className="text-xs text-[#c3cede]">
              <summary className="cursor-pointer text-2xs text-muted">Alternative hypotheses ({alternatives.length})</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 marker:text-subtle">
                {alternatives.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : session.detail ? (
        <p className="text-xs text-muted">The stored response of this session has no diagnosis to show.</p>
      ) : null}

      {view.patches.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Proposed patch</p>
          {view.patches.map((p, i) => (
            <details key={`${p.path}-${i}`} className="rounded-lg border border-border bg-surface/60">
              <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs">
                <FileDiff className="size-3.5 text-subtle" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-text">{p.path}</span>
                {p.added !== null && <span className="font-mono text-2xs text-[#4ade80]">+{formatNumber(p.added)}</span>}
                {p.removed !== null && <span className="font-mono text-2xs text-[#f87171]">−{formatNumber(p.removed)}</span>}
              </summary>
              {p.diff ? (
                <UnifiedDiff diff={p.diff} />
              ) : (
                <p className="border-t border-border px-2.5 py-2 text-2xs text-subtle">No diff stored for this file.</p>
              )}
            </details>
          ))}
        </div>
      )}

      {view.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-2xs leading-4 text-muted marker:text-subtle">
          {view.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}

      {view.validation && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/60 px-2.5 py-2 text-xs">
          <span className="text-muted">Pre-validation run{view.validation.id !== null ? ` #${view.validation.id}` : ''}:</span>
          {view.validation.status ? <StatusBadge status={view.validation.status} size="xs" /> : <span className="text-subtle">no status</span>}
          {view.validation.total !== null && view.validation.passed !== null && (
            <span className="tabular-nums text-muted">
              {formatNumber(view.validation.passed)}/{formatNumber(view.validation.total)} checks
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink to={debuggerLink} size="sm" variant="primary" icon={<Bug />}>
          {view.patches.length > 0 && !session.applied ? 'Review and apply in the Debugger' : 'Open in the Debugger'}
        </ButtonLink>
      </div>
      <InteractionMeta interaction={record} />
    </div>
  );
}

function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.replace(/\r\n?/g, '\n').split('\n');
  return (
    <pre className="max-h-72 overflow-auto border-t border-border px-0 py-1 font-mono text-[11px] leading-[18px]">
      {lines.map((line, i) => (
        <div
          key={i}
          className={clsx(
            'whitespace-pre px-2.5',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-pass/10 text-[#86efac]',
            line.startsWith('-') && !line.startsWith('---') && 'bg-fail/10 text-[#fca5a5]',
            line.startsWith('@@') && 'text-accent',
            (line.startsWith('+++') || line.startsWith('---')) && 'text-subtle',
            !/^[-+@]/.test(line) && 'text-[#9fb0c8]',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
