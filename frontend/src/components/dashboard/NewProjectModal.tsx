import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderPlus } from 'lucide-react';
import { SIMULATORS, type Simulator } from '../../services/types';
import { api } from '../../services/api';
import { simulatorAvailability } from '../../lib/system';
import { simulatorLabel } from '../../lib/format';
import { useProject } from '../../state/ProjectContext';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/ErrorBanner';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { TextArea } from '../ui/TextArea';
import { useToast } from '../ui/Toast';
import { readDefaultSimulator } from '../settings/preferences';

export interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
}

/** Creates an empty project (POST /api/projects), selects it and opens the RTL Editor. */
export function NewProjectModal({ open, onClose }: NewProjectModalProps) {
  const { openProject, refreshProjects, systemStatus } = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [spec, setSpec] = useState('');
  const [simulator, setSimulator] = useState<Simulator>('icarus');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setSpec('');
    setSimulator(readDefaultSimulator());
    setError(null);
  }, [open]);

  const availability = simulatorAvailability(systemStatus);
  const trimmed = name.trim();

  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await api.projects.create({ name: trimmed, description: description.trim(), spec: spec.trim(), simulator });
      openProject(detail);
      void refreshProjects();
      toast.success('Project created', `${detail.name} is now the current project.`);
      onClose();
      navigate('/studio');
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
      description="An empty project: add or upload RTL in the RTL Editor, or generate it with the AI Generator."
      icon={<FolderPlus />}
      initialFocusRef={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<FolderPlus />} loading={busy} disabled={!trimmed} onClick={() => void submit()}>
            Create and open
          </Button>
        </>
      }
    >
      <form className="grid gap-3.5" onSubmit={(e) => void submit(e)}>
        <Input
          ref={nameRef}
          label="Name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onEnter}
          placeholder="e.g. uart_rx"
        />
        <Input
          label="Description"
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onEnter}
          placeholder="Optional"
        />
        <TextArea
          label="Specification"
          hint="Optional natural-language spec. The AI testbench generator and debugger use it as the design intent."
          rows={4}
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
        />
        <Select
          label="Simulator"
          hint="Default from Settings → Preferences. It can be changed later in the top bar."
          value={simulator}
          onChange={(e) => setSimulator(e.target.value === 'verilator' ? 'verilator' : 'icarus')}
          options={SIMULATORS.map((sim) => ({
            value: sim,
            label: availability[sim].available ? simulatorLabel(sim) : `${simulatorLabel(sim)} (unavailable on the backend)`,
          }))}
        />
        {error !== null && <ErrorBanner error={error} title="Could not create the project" />}
      </form>
    </Modal>
  );
}
