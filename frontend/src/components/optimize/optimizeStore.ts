/**
 * In-flight and finished AI optimizations per project (module-level, this browser tab only):
 * leaving the Optimize page does not lose a running request or its result. Not persisted -
 * a reload starts fresh, because the project's files may have changed since.
 */
import { JobRegistry } from '../generator/aiJobs';
import type { OptimizeSession } from './synthMetrics';

export const optimizeJobs = new JobRegistry<OptimizeSession>();

export function optimizeKey(projectId: number): string {
  return `project-${projectId}`;
}
