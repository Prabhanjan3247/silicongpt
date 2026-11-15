import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { pluralize } from '../../lib/format';
import { useProject } from '../../state/ProjectContext';
import { useToast } from '../ui/Toast';

export interface ExampleLauncher {
  /** Instantiates example `key` (fresh project copy), selects it and opens the RTL Editor. */
  launch: (key: string, name?: string) => Promise<void>;
  /** Key of the example being instantiated, or null. */
  busyKey: string | null;
}

/** POST /api/examples/{key}/instantiate -> select the new project -> /studio. */
export function useExampleLauncher(target = '/studio'): ExampleLauncher {
  const { openProject, refreshProjects } = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);

  const launch = useCallback(
    async (key: string, name?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusyKey(key);
      try {
        const detail = await api.examples.instantiate(key);
        openProject(detail);
        void refreshProjects();
        toast.success('Project created', `${detail.name}: ${pluralize(detail.files.length, 'file')} copied from the verified example.`);
        navigate(target);
      } catch (err) {
        toast.error(`Could not create a project from ${name ?? key}`, err);
      } finally {
        busyRef.current = false;
        setBusyKey(null);
      }
    },
    [navigate, openProject, refreshProjects, target, toast],
  );

  return { launch, busyKey };
}
