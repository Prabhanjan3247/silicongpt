import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FilePlus2, FolderPlus, TestTubeDiagonal } from 'lucide-react';
import { SIMULATORS, type ProjectDetail, type Simulator } from '../../services/types';
import { formatBytes, pluralize, simulatorLabel, truncate } from '../../lib/format';
import { simulatorAvailability } from '../../lib/system';
import { useProject } from '../../state/ProjectContext';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/ErrorBanner';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { readDefaultSimulator } from '../settings/preferences';
import { addDesignToProject, createProjectFromDesign, planAdd, type AddPlanItem } from './designActions';
import type { GeneratorSession } from './generatorStore';

export type SaveIntent = 'create' | 'add' | 'testbench';

export interface SaveOutcome {
  target: 'new' | 'current';
  detail: ProjectDetail;
  /** Human summary of what was written. */
  message: string;
}

export interface SaveDesignModalProps {
  open: boolean;
  intent: SaveIntent;
  session: GeneratorSession;
  onClose: () => void;
  onSaved: (outcome: SaveOutcome) => void;
}

const TITLES: Record<SaveIntent, string> = {
  create: 'Create a project from the design',
  add: 'Add the design to the current project',
  testbench: 'Save the design, then generate a testbench',
};

function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Writes the generated design into a new or the current project (real project / file endpoints). */
export function SaveDesignModal({ open, intent, session, onClose, onSaved }: SaveDesignModalProps) {
  const { project, files: projectFiles, systemStatus } = useProject();
  const design = session.design;
  const files = design.rtl.files;
  const top = design.rtl.top_module || design.architecture.module_name || null;
  const nameRef = useRef<HTMLInputElement>(null);

  const [target, setTarget] = useState<'new' | 'current'>('new');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [simulator, setSimulator] = useState<Simulator>('icarus');
  const [items, setItems] = useState<AddPlanItem[]>([]);
  const [setTop, setSetTop] = useState(true);
  const [saveSpec, setSaveSpec] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(intent === 'add' ? 'current' : 'new');
    setName(top ?? 'Generated design');
    setDescription(truncate(design.architecture.summary || '', 2000));
    setSimulator(readDefaultSimulator());
    setError(null);
  }, [open, intent, top, design.architecture.summary]);

  const projectId = project?.id ?? null;
  const projectTop = project?.top_module ?? null;
  const projectSpecEmpty = !(project?.spec ?? '').trim();
  useEffect(() => {
    if (!open || projectId === null) return;
    setItems(planAdd(files, projectFiles));
    setSetTop(!projectTop || projectTop === top);
    setSaveSpec(projectSpecEmpty);
  }, [open, projectId, projectFiles, files, projectTop, projectSpecEmpty, top]);

  const availability = simulatorAvailability(systemStatus);
  const useCurrent = target === 'current' && project !== null;
  const conflicts = items.filter((i) => i.existing !== null);
  const writes = useCurrent ? items.filter((i) => !i.existing || i.overwrite).length : files.length;
  const nothingToDo = useCurrent && writes === 0 && !(setTop && top) && !saveSpec;
  const invalid = target === 'new' ? !name.trim() : !project || (intent === 'add' && nothingToDo);

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!useCurrent) {
        const detail = await createProjectFromDesign({
          name: name.trim(),
          description: description.trim(),
          spec: session.spec,
          simulator,
          files,
          topModule: top,
        });
        onSaved({ target: 'new', detail, message: `${detail.name}: ${pluralize(files.length, 'file')} written${top ? `, top module ${top}` : ''}.` });
      } else if (project) {
        const res = await addDesignToProject({
          projectId: project.id,
          items,
          setTop: setTop && top ? top : null,
          saveSpec: saveSpec ? session.spec : null,
        });
        const parts: string[] = [];
        if (res.created.length) parts.push(`${pluralize(res.created.length, 'file')} added`);
        if (res.overwritten.length) parts.push(`${pluralize(res.overwritten.length, 'file')} overwritten (previous content kept as a revision)`);
        if (res.skipped.length) parts.push(`${pluralize(res.skipped.length, 'existing file')} left unchanged`);
        onSaved({ target: 'current', detail: res.detail, message: `${res.detail.name}: ${parts.join(', ') || 'no file changed'}.` });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitLabel =
    intent === 'testbench'
      ? useCurrent && writes === 0
        ? 'Generate testbench'
        : 'Save and generate testbench'
      : useCurrent
        ? `Write ${pluralize(writes, 'file')}`
        : intent === 'create'
          ? 'Create project and open RTL Editor'
          : 'Create project';

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      size="lg"
      title={TITLES[intent]}
      description={
        intent === 'testbench'
          ? 'The testbench generator works on a project: it reads the design files from it and saves the testbench next to them.'
          : 'The generated files are stored as regular project files that you can edit, lint and simulate.'
      }
      icon={intent === 'testbench' ? <TestTubeDiagonal /> : intent === 'add' ? <FilePlus2 /> : <FolderPlus />}
      initialFocusRef={target === 'new' ? nameRef : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={intent === 'testbench' ? <TestTubeDiagonal /> : useCurrent ? <FilePlus2 /> : <FolderPlus />}
            loading={busy}
            disabled={invalid}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {intent !== 'add' && intent !== 'create' && (
          <div role="radiogroup" aria-label="Target project" className="grid gap-2 sm:grid-cols-2">
            {(
              [
                { id: 'new', label: 'New project', detail: 'Create a project with the generated files.' },
                {
                  id: 'current',
                  label: project ? `Current project: ${project.name}` : 'Current project',
                  detail: project ? 'Write the generated files into the selected project.' : 'No project is selected.',
                },
              ] as const
            ).map((opt) => {
              const disabled = opt.id === 'current' && !project;
              const selected = target === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => setTarget(opt.id)}
                  className={clsx(
                    'rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    selected ? 'border-accent/55 bg-accent/[0.06]' : 'border-border-strong bg-surface hover:bg-hover/60',
                  )}
                >
                  <span className="block truncate text-[13px] font-medium text-text">{opt.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{opt.detail}</span>
                </button>
              );
            })}
          </div>
        )}

        {!useCurrent ? (
          <div className="grid gap-3.5">
            <Input ref={nameRef} label="Project name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Description" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            <Select
              label="Simulator"
              hint="Default from Settings → Preferences."
              value={simulator}
              onChange={(e) => setSimulator(e.target.value === 'verilator' ? 'verilator' : 'icarus')}
              options={SIMULATORS.map((sim) => ({
                value: sim,
                label: availability[sim].available ? simulatorLabel(sim) : `${simulatorLabel(sim)} (unavailable on the backend)`,
              }))}
            />
            <div>
              <p className="mb-1.5 text-xs font-medium text-[#c3cede]">Files</p>
              <ul className="grid gap-1 rounded-lg border border-border bg-surface/70 p-2">
                {files.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-text">{f.path}</span>
                    <span className="ml-auto text-2xs text-subtle">{formatBytes(byteSize(f.content))}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-2xs text-subtle">
                The specification is stored on the project{top ? <> and <span className="font-mono">{top}</span> is set as its top module</> : null}.
              </p>
            </div>
          </div>
        ) : project ? (
          <div className="grid gap-3">
            <div>
              <p className="mb-1.5 text-xs font-medium text-[#c3cede]">
                Files for <span className="text-text">{project.name}</span>
              </p>
              <ul className="grid gap-1 rounded-lg border border-border bg-surface/70 p-2">
                {items.map((item, index) => (
                  <li key={item.file.path} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-text">{item.file.path}</span>
                    {item.existing ? (
                      <>
                        <Badge tone="warn" size="xs">
                          exists
                        </Badge>
                        <label className="ml-auto inline-flex items-center gap-1.5 text-muted">
                          <input
                            type="checkbox"
                            checked={item.overwrite}
                            onChange={(e) =>
                              setItems((list) => list.map((it, i) => (i === index ? { ...it, overwrite: e.target.checked } : it)))
                            }
                            className="accent-[#22d3ee]"
                          />
                          Overwrite
                        </label>
                      </>
                    ) : (
                      <Badge tone="pass" size="xs" className="ml-auto">
                        new file
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
              {conflicts.length > 0 && (
                <p className="mt-1.5 text-2xs leading-4 text-subtle">
                  Overwritten files keep their previous content as a revision (reason “ai_generate”) and can be reverted in the RTL Editor.
                </p>
              )}
            </div>
            {top && (
              <label className="inline-flex items-start gap-2 text-xs text-[#c3cede]">
                <input type="checkbox" checked={setTop} onChange={(e) => setSetTop(e.target.checked)} className="mt-0.5 accent-[#22d3ee]" />
                <span>
                  Set the top module to <span className="font-mono text-text">{top}</span>
                  <span className="text-subtle"> (currently {project.top_module ? <span className="font-mono">{project.top_module}</span> : 'auto-detected'})</span>
                </span>
              </label>
            )}
            <label className="inline-flex items-start gap-2 text-xs text-[#c3cede]">
              <input type="checkbox" checked={saveSpec} onChange={(e) => setSaveSpec(e.target.checked)} className="mt-0.5 accent-[#22d3ee]" />
              <span>
                Store this specification on the project
                <span className="text-subtle">{projectSpecEmpty ? ' (the project has no spec yet)' : ' (replaces the current spec)'}</span>
              </span>
            </label>
            {intent === 'add' && nothingToDo && <p className="text-xs text-warn">Nothing would change: select files to overwrite or an option above.</p>}
          </div>
        ) : (
          <p className="text-xs text-muted">Select a project in the top bar first, or create a new one.</p>
        )}

        {error !== null && <ErrorBanner error={error} title="Could not save the design" />}
      </div>
    </Modal>
  );
}
