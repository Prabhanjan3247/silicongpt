/**
 * Writes a generated design into a project through the regular project / file endpoints:
 *  - create:  POST /projects (name, description, spec, simulator) -> POST /files per file ->
 *             PATCH top_module. A failure after the project exists removes it again (DELETE).
 *  - add:     POST /files for new names, PUT (revision reason "ai_generate") for files the user
 *             chose to overwrite, optional PATCH of top_module / spec.
 */
import { api, ApiError, errorMessage } from '../../services/api';
import type { FileMeta, GeneratedFile, ProjectDetail, Simulator, UpdateProjectRequest } from '../../services/types';

/** Revision reason stored with the previous content of an overwritten file. */
export const GENERATE_REVISION_REASON = 'ai_generate';

/** Re-throws `err` with extra context appended to its message (keeps the HTTP status). */
function withContext(err: unknown, context: string): Error {
  if (err instanceof ApiError) {
    return new ApiError({
      status: err.status,
      kind: err.kind,
      body: err.body,
      method: err.method,
      path: err.path,
      detail: `${err.detail} ${context}`.trim(),
    });
  }
  return new Error(`${errorMessage(err)} ${context}`.trim());
}

export interface CreateFromDesignInput {
  name: string;
  description: string;
  spec: string;
  simulator: Simulator;
  files: readonly GeneratedFile[];
  /** Top module to store on the project (null = let the backend detect it). */
  topModule: string | null;
}

export async function createProjectFromDesign(input: CreateFromDesignInput): Promise<ProjectDetail> {
  const created = await api.projects.create({
    name: input.name,
    description: input.description,
    spec: input.spec,
    simulator: input.simulator,
  });
  let written = 0;
  try {
    for (const file of input.files) {
      await api.files.create(created.id, { path: file.path, content: file.content });
      written += 1;
    }
    return input.topModule
      ? await api.projects.update(created.id, { top_module: input.topModule })
      : await api.projects.get(created.id);
  } catch (err) {
    let removed = false;
    try {
      await api.projects.remove(created.id);
      removed = true;
    } catch {
      removed = false;
    }
    throw withContext(
      err,
      removed
        ? `The partially created project “${created.name}” was removed again.`
        : `Project “${created.name}” (#${created.id}) was created but is incomplete (${written} of ${input.files.length} files written); delete it on the Projects page.`,
    );
  }
}

export interface AddPlanItem {
  file: GeneratedFile;
  /** Project file with the same name (case-insensitive), or null for a new file. */
  existing: FileMeta | null;
  /** Overwrite `existing` (its previous content is kept as a revision). */
  overwrite: boolean;
}

export interface AddToProjectInput {
  projectId: number;
  items: readonly AddPlanItem[];
  /** Set the project's top module to this name (null = leave it). */
  setTop: string | null;
  /** Store this spec on the project (null = leave it). */
  saveSpec: string | null;
}

export interface AddToProjectResult {
  detail: ProjectDetail;
  created: string[];
  overwritten: string[];
  skipped: string[];
}

/** Matches generated files with the project's files (names are case-insensitive on the backend). */
export function planAdd(files: readonly GeneratedFile[], projectFiles: readonly FileMeta[]): AddPlanItem[] {
  return files.map((file) => {
    const existing = projectFiles.find((f) => f.path.toLowerCase() === file.path.toLowerCase()) ?? null;
    return { file, existing, overwrite: false };
  });
}

export async function addDesignToProject(input: AddToProjectInput): Promise<AddToProjectResult> {
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  try {
    for (const item of input.items) {
      if (item.existing) {
        if (!item.overwrite) {
          skipped.push(item.file.path);
          continue;
        }
        await api.files.save(input.projectId, item.existing.id, {
          content: item.file.content,
          reason: GENERATE_REVISION_REASON,
        });
        overwritten.push(item.existing.path);
      } else {
        await api.files.create(input.projectId, { path: item.file.path, content: item.file.content });
        created.push(item.file.path);
      }
    }
    const patch: UpdateProjectRequest = {};
    if (input.setTop) patch.top_module = input.setTop;
    if (input.saveSpec !== null) patch.spec = input.saveSpec;
    const detail = Object.keys(patch).length > 0 ? await api.projects.update(input.projectId, patch) : await api.projects.get(input.projectId);
    return { detail, created, overwritten, skipped };
  } catch (err) {
    const done = [...created, ...overwritten];
    throw withContext(err, done.length > 0 ? `Already written before the error: ${done.join(', ')}.` : 'No project file was changed.');
  }
}
