import { useEffect, useRef, useState } from 'react';
import { ChevronDown, History, RotateCcw } from 'lucide-react';
import { api, isAbortError } from '../../services/api';
import type { FileMeta, ProjectFile, RevisionDetail, RevisionMeta } from '../../services/types';
import { formatBytes, formatDateTime, formatRelative } from '../../lib/format';
import type { Tone } from '../../lib/status';
import { DiffViewer } from '../../editor/DiffViewer';
import { Badge, Button, ErrorBanner, LoadingState, Modal, Spinner } from '../ui';
import { MenuItem, MenuLabel, Popover } from './Popover';

const REASON: Record<string, { label: string; tone: Tone }> = {
  edit: { label: 'edit', tone: 'neutral' },
  format: { label: 'format', tone: 'blue' },
  revert: { label: 'revert', tone: 'violet' },
  ai_patch: { label: 'AI patch', tone: 'accent' },
  fault_injection: { label: 'fault injection', tone: 'fail' },
};

export function revisionReason(reason: string): { label: string; tone: Tone } {
  return REASON[reason] ?? { label: reason.replace(/_/g, ' '), tone: 'neutral' };
}

export interface RevisionMenuProps {
  projectId: number;
  file: FileMeta;
  /** Editor content (the diff compares a revision with it). */
  currentContent: string;
  dirty: boolean;
  disabled?: boolean;
  onReverted: (file: ProjectFile) => void;
}

/**
 * Revision history dropdown of the active file (GET .../revisions). A revision holds the content a
 * change replaced; choosing one opens a diff against the editor with a "restore" action.
 */
export function RevisionMenu({ projectId, file, currentContent, dirty, disabled = false, onReverted }: RevisionMenuProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<RevisionMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<RevisionMeta | null>(null);

  useEffect(() => {
    setList(null);
    setSelected(null);
  }, [file.id]);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.files
      .revisions(projectId, file.id, { signal: controller.signal })
      .then((revs) => setList([...revs].sort((a, b) => b.id - a.id)))
      .catch((err) => {
        if (!isAbortError(err)) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, projectId, file.id, file.updated_at]);

  return (
    <>
      <Button
        ref={anchorRef}
        size="sm"
        variant="ghost"
        icon={<History />}
        iconRight={<ChevronDown className="opacity-60" />}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title="Revision history of this file"
        onClick={() => setOpen((v) => !v)}
      >
        History
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="end" width={360} label="Revision history">
        <MenuLabel>
          <span className="normal-case tracking-normal">
            Revisions of <span className="font-mono">{file.path}</span>
          </span>
        </MenuLabel>
        {loading && !list ? (
          <div className="flex justify-center px-3 py-4 text-muted">
            <Spinner size="sm" label="Loading revisions…" />
          </div>
        ) : error ? (
          <div className="p-1.5">
            <ErrorBanner error={error} title="Could not load the revisions" />
          </div>
        ) : list && list.length === 0 ? (
          <p className="px-3 pb-3 pt-1 text-xs leading-5 text-muted">
            No revisions yet. Saving, formatting, reverting, AI patches and fault injection keep the replaced content
            here.
          </p>
        ) : (
          list?.map((rev) => {
            const reason = revisionReason(rev.reason);
            return (
              <MenuItem
                key={rev.id}
                icon={<RotateCcw />}
                label={
                  <span className="flex items-center gap-2">
                    <span>Before</span>
                    <Badge tone={reason.tone} size="xs">
                      {reason.label}
                    </Badge>
                    <span className="font-mono text-2xs text-subtle">#{rev.id}</span>
                  </span>
                }
                description={`${formatDateTime(rev.created_at)} · ${formatBytes(rev.size)}`}
                hint={formatRelative(rev.created_at)}
                onSelect={() => {
                  setSelected(rev);
                  setOpen(false);
                }}
              />
            );
          })
        )}
      </Popover>
      <RevisionModal
        projectId={projectId}
        file={file}
        revision={selected}
        currentContent={currentContent}
        dirty={dirty}
        onClose={() => setSelected(null)}
        onReverted={onReverted}
      />
    </>
  );
}

interface RevisionModalProps {
  projectId: number;
  file: FileMeta;
  revision: RevisionMeta | null;
  currentContent: string;
  dirty: boolean;
  onClose: () => void;
  onReverted: (file: ProjectFile) => void;
}

function RevisionModal({ projectId, file, revision, currentContent, dirty, onClose, onReverted }: RevisionModalProps) {
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<unknown>(null);
  const revisionId = revision?.id ?? null;

  useEffect(() => {
    setDetail(null);
    setRevertError(null);
    if (revisionId === null) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.files
      .revision(projectId, file.id, revisionId, { signal: controller.signal })
      .then(setDetail)
      .catch((err) => {
        if (!isAbortError(err)) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, file.id, revisionId]);

  const restore = async () => {
    if (revisionId === null) return;
    setReverting(true);
    setRevertError(null);
    try {
      const restored = await api.files.revert(projectId, file.id, revisionId);
      onReverted(restored);
      onClose();
    } catch (err) {
      setRevertError(err);
    } finally {
      setReverting(false);
    }
  };

  const reason = revision ? revisionReason(revision.reason) : null;
  const identical = detail !== null && detail.content === currentContent;

  return (
    <Modal
      open={revision !== null}
      onClose={reverting ? () => undefined : onClose}
      size="full"
      icon={<History />}
      title={
        revision ? (
          <span>
            Revision #{revision.id} of <span className="font-mono">{file.path}</span>
          </span>
        ) : (
          'Revision'
        )
      }
      description={
        revision && reason
          ? `Content before the ${reason.label} of ${formatDateTime(revision.created_at)}, compared with the ${dirty ? 'unsaved editor content' : 'current file'}.`
          : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={reverting}>
            Close
          </Button>
          <Button
            variant="primary"
            icon={<RotateCcw />}
            loading={reverting}
            disabled={detail === null || identical}
            title={identical ? 'The revision is identical to the editor content' : undefined}
            onClick={() => void restore()}
          >
            Restore this version
          </Button>
        </>
      }
    >
      {loading ? (
        <LoadingState label="Loading revision…" minHeight="16rem" />
      ) : error ? (
        <ErrorBanner error={error} title="Could not load the revision" />
      ) : detail ? (
        <DiffViewer
          original={detail.content}
          modified={currentContent}
          path={file.path}
          originalLabel={`revision #${detail.id}`}
          modifiedLabel={dirty ? 'editor (unsaved)' : 'current'}
          height="min(60vh, 600px)"
        />
      ) : null}
      <p className="mt-3 text-xs leading-5 text-muted">
        Restoring stores this content as the current file; the content it replaces is kept as a new &quot;revert&quot;
        revision, so the restore can be undone.
        {dirty && <span className="text-[#fcd34d]"> The unsaved editor content is replaced as well.</span>}
      </p>
      {revertError ? <ErrorBanner error={revertError} title="Could not restore the revision" className="mt-3" /> : null}
    </Modal>
  );
}
