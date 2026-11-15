import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FolderPlus } from 'lucide-react';
import { api } from '../../services/api';
import { SIMULATORS, type ProjectDetail, type Simulator } from '../../services/types';
import { simulatorLabel } from '../../lib/format';
import { simulatorAvailability } from '../../lib/system';
import { useProject } from '../../state/ProjectContext';
import { Button, ErrorBanner, Input, Modal, Select, TextArea } from '../ui';

export interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (detail: ProjectDetail) => void;
}

const NAME_MAX = 200;

/** POST /api/projects {name, description, spec, simulator}. */
export function CreateProjectModal({ open, onClose, onCreated }: CreateProjectModalProps) {
  const { systemStatus } = useProject();
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [spec, setSpec] = useState('');
  const [simulator, setSimulator] = useState<Simulator>('icarus');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const availability = simulatorAvailability(systemStatus);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setSpec('');
    setSimulator('icarus');
    setTouched(false);
    setError(null);
  }, [open]);

  const trimmed = name.trim();
  const nameError = !trimmed ? 'Enter a project name.' : trimmed.length > NAME_MAX ? `At most ${NAME_MAX} characters.` : null;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (nameError || busy) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await api.projects.create({ name: trimmed, description: description.trim(), spec, simulator });
      onCreated(detail);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="New project"
      description="An empty RTL project. Add sources in the editor, or generate them with the AI Generator."
      icon={<FolderPlus />}
      size="lg"
      initialFocusRef={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} disabled={touched && Boolean(nameError)}>
            Create and open
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          ref={nameRef}
          label="Name"
          required
          value={name}
          maxLength={NAME_MAX + 20}
          placeholder="e.g. 8-bit ALU"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(trimmed.length > 0 || touched)}
          error={touched ? nameError : null}
          autoComplete="off"
        />
        <Input
          label="Description"
          value={description}
          placeholder="Optional one-line summary"
          onChange={(e) => setDescription(e.target.value)}
          autoComplete="off"
        />
        <Select
          label="Simulator"
          value={simulator}
          onChange={(e) => setSimulator(e.target.value as Simulator)}
          options={SIMULATORS.map((s) => ({
            value: s,
            label: availability[s].available ? simulatorLabel(s) : `${simulatorLabel(s)} (unavailable on the backend)`,
          }))}
          hint={availability[simulator].reason ?? 'Used by Compile and Run Simulation; you can switch it later.'}
          error={availability[simulator].available ? null : availability[simulator].reason}
        />
        <TextArea
          label="Specification"
          value={spec}
          rows={6}
          placeholder="Optional natural-language spec: ports, behaviour, reset, timing. The AI agents use it to generate and check the design."
          onChange={(e) => setSpec(e.target.value)}
          hint="You can edit it later in the editor's Spec tab."
        />
        {error ? <ErrorBanner error={error} title="Could not create the project" /> : null}
      </form>
    </Modal>
  );
}
