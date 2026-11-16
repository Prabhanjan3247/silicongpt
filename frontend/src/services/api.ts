/**
 * Typed client for every SiliconGPT REST endpoint (CONTRACTS.md section 4).
 *
 *   import { api, ApiError } from '../services/api';
 *   const run = await api.simulation.simulate(projectId, { simulator: 'icarus' });
 *
 * Every method takes an optional trailing `RequestOptions` ({ signal, timeoutMs }) and rejects
 * with `ApiError { status, detail }` - `detail` is the backend's `{"detail": ...}` message (e.g.
 * the AI 503 "Claude API credentials not configured"). status 0 = no HTTP response
 * (network failure, timeout, cancellation or a client-side parse problem; see `kind`).
 */
import type {
  AIInteractionDetail,
  AIRecord,
  AnalyzeRunResponse,
  ApplyPatchesResponse,
  AskRequest,
  AskResponse,
  CompileOutcome,
  CompileRequest,
  CreateFileRequest,
  CreateProjectRequest,
  DashboardData,
  DebugResponse,
  Example,
  ExplainRequest,
  ExplainResponse,
  FileMeta,
  GenerateRtlRequest,
  GenerateRtlResponse,
  GenerateTestbenchRequest,
  GenerateTestbenchResponse,
  HealthResponse,
  Hierarchy,
  InjectBugResult,
  LintRequest,
  LintResult,
  OkResponse,
  OptimizeRequest,
  OptimizeResponse,
  Project,
  ProjectBundle,
  ProjectDetail,
  ProjectFile,
  ProjectReport,
  ReportFormat,
  RevisionDetail,
  RevisionMeta,
  RunDetail,
  RunSummary,
  SaveFileRequest,
  SimulateRequest,
  SynthesizeRequest,
  SynthRun,
  SystemStatus,
  UpdateFileMetaRequest,
  UpdateProjectRequest,
  WaveformDataRequest,
  WaveSample,
  WaveSignalList,
  WaveWindow,
} from './types';

/* ============================================================================ configuration */

const configuredBase = import.meta.env.VITE_API_BASE?.trim();

/** Base URL of the API ("/api" by default; the Vite dev server proxies it to 127.0.0.1:8000). */
export const API_BASE: string = (configuredBase ? configuredBase : '/api').replace(/\/+$/, '');

/** Browser-side request timeouts (ms). The backend may keep working after a client timeout. */
export const TIMEOUTS = {
  /** Plain CRUD / reads. */
  default: 60_000,
  /** Real tool runs: lint, compile, simulate (Verilator builds take ~20 s + limits), synthesis. */
  tool: 6 * 60_000,
  /** AI agents and workflows: several Claude calls (up to ~10 min each) plus real tool runs. */
  ai: 20 * 60_000,
  /** Uploads and downloads (VCD files can be tens of MB). */
  transfer: 5 * 60_000,
} as const;

export interface RequestOptions {
  /** Cancels the request (the promise rejects with an ApiError of kind "aborted"). */
  signal?: AbortSignal;
  /** Overrides the default timeout for this call; 0 disables the timeout. */
  timeoutMs?: number;
}

export interface DownloadOptions extends RequestOptions {
  /** File name to save as (default: server Content-Disposition, else a descriptive name). */
  filename?: string;
}

/* ============================================================================ errors */

export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'parse';

export interface ApiErrorInit {
  status: number;
  detail: string;
  kind: ApiErrorKind;
  body?: unknown;
  method?: string;
  path?: string;
}

export class ApiError extends Error {
  /** HTTP status, or 0 when no HTTP response was received. */
  readonly status: number;
  /** Human-readable error text (the backend's `detail`). */
  readonly detail: string;
  readonly kind: ApiErrorKind;
  /** Parsed error body (JSON or text) when the server sent one. */
  readonly body: unknown;
  readonly method: string;
  readonly path: string;

  constructor(init: ApiErrorInit) {
    super(init.detail);
    this.name = 'ApiError';
    this.status = init.status;
    this.detail = init.detail;
    this.kind = init.kind;
    this.body = init.body;
    this.method = init.method ?? '';
    this.path = init.path ?? '';
  }

  get isAborted(): boolean {
    return this.kind === 'aborted';
  }

  get isTimeout(): boolean {
    return this.kind === 'timeout';
  }

  get isNetworkError(): boolean {
    return this.kind === 'network';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** 503: AI credentials missing / authentication failed. */
  get isAIUnavailable(): boolean {
    return this.status === 503;
  }

  /** 502: refusal, truncated or invalid AI response. */
  get isAIResponseError(): boolean {
    return this.status === 502;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** True for errors caused by our own cancellation (unmount, superseded request). */
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof ApiError && err.kind === 'aborted') ||
    (err instanceof DOMException && err.name === 'AbortError')
  );
}

/** Best human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.detail;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Formats FastAPI `detail` values: strings, and 422 validation arrays `[{loc, msg}]`. */
export function formatErrorDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === 'object') {
          const entry = item as { loc?: unknown; msg?: unknown };
          const loc = Array.isArray(entry.loc)
            ? entry.loc.filter((part) => part !== 'body').join('.')
            : '';
          const msg = typeof entry.msg === 'string' ? entry.msg : JSON.stringify(item);
          return loc ? `${loc}: ${msg}` : msg;
        }
        return String(item);
      })
      .join('\n');
  }
  if (typeof detail === 'object') {
    const obj = detail as { message?: unknown };
    if (typeof obj.message === 'string') return obj.message;
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return String(detail);
}

/* ============================================================================ core request */

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type QueryValue = string | number | boolean | null | undefined;

export interface CallOptions extends RequestOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  /** JSON request body. */
  json?: unknown;
  /** Multipart request body (takes precedence over `json`). */
  form?: FormData;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  let url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

async function errorFromResponse(res: Response, method: string, path: string): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  let detail = '';
  const isHtml = (res.headers.get('Content-Type') ?? '').includes('text/html') || /^\s*<(!doctype|html)/i.test(text);
  if (body && typeof body === 'object' && 'detail' in body) {
    detail = formatErrorDetail((body as { detail: unknown }).detail);
  } else if (isHtml) {
    // A proxy / web server error page, not an API response: do not dump its markup.
    const isGitHubPages = typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
    if (isGitHubPages) {
      detail = `You are viewing SiliconGPT on GitHub Pages (static preview). GitHub Pages cannot run the Python/EDA compiler backend. To run simulations, open the app locally at http://localhost:5173 with your backend running.`;
    } else {
      detail = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}: the server returned an HTML page instead of an API response (${method} ${API_BASE}${path}).`;
    }
  } else if (typeof body === 'string') {
    detail = body.trim().slice(0, 800);
  }
  if (!detail) {
    detail = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} with an empty response body.`;
    if (res.status === 500 || res.status === 502 || res.status === 504) {
      detail +=
        ' If you are using the Vite dev server, the backend at 127.0.0.1:8000 is probably not running or not reachable.';
    }
  }
  return new ApiError({ status: res.status, detail, kind: 'http', body, method, path });
}

function transportError(
  err: unknown,
  ctx: { timedOut: boolean; timeoutMs: number; cancelled: boolean; method: string; path: string },
): ApiError {
  if (err instanceof ApiError) return err;
  const { method, path } = ctx;
  if (ctx.timedOut) {
    const after = ctx.timeoutMs < 1000 ? `${ctx.timeoutMs} ms` : `${Math.round(ctx.timeoutMs / 1000)} s`;
    return new ApiError({
      status: 0,
      kind: 'timeout',
      method,
      path,
      detail: `Request timed out after ${after} (${method} ${path}). The backend may still be processing it.`,
    });
  }
  if (ctx.cancelled) {
    return new ApiError({ status: 0, kind: 'aborted', method, path, detail: 'Request cancelled.' });
  }
  return new ApiError({
    status: 0,
    kind: 'network',
    method,
    path,
    detail: `Cannot reach the SiliconGPT backend at ${API_BASE} (${errorMessage(err)}). Check that the API server is running.`,
  });
}

/**
 * Low-level request helper used by `api.*`. Exported so pages can call an endpoint that is not
 * wrapped yet without editing this module: `apiRequest<T>('/path', { method: 'POST', json })`.
 */
export async function apiRequest<T>(
  path: string,
  opts: CallOptions = {},
  read: (res: Response) => Promise<T> = readJson as (res: Response) => Promise<T>,
): Promise<T> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.default;
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  const ctx = () => ({ timedOut, timeoutMs, cancelled: Boolean(external?.aborted), method, path });
  try {
    let res: Response;
    try {
      res = await fetch(buildUrl(path, opts.query), {
        method,
        headers,
        body,
        signal: controller.signal,
        credentials: 'same-origin',
      });
    } catch (err) {
      throw transportError(err, ctx());
    }
    if (!res.ok) throw await errorFromResponse(res, method, path);
    try {
      return await read(res);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (controller.signal.aborted) throw transportError(err, ctx());
      throw new ApiError({
        status: res.status,
        kind: 'parse',
        method,
        path,
        detail: `Could not read the response to ${method} ${path}: ${errorMessage(err)}`,
      });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function readText(res: Response): Promise<string> {
  return res.text();
}

const get = <T>(path: string, opts?: RequestOptions, query?: Record<string, QueryValue>) =>
  apiRequest<T>(path, { ...opts, method: 'GET', query });

const send = <T>(
  method: Exclude<HttpMethod, 'GET'>,
  path: string,
  json: unknown,
  opts: RequestOptions | undefined,
  defaultTimeout: number = TIMEOUTS.default,
) => apiRequest<T>(path, { ...opts, method, json, timeoutMs: opts?.timeoutMs ?? defaultTimeout });

/* ============================================================================ downloads */

/** Saves a Blob through a temporary <a download> link (triggers the browser download). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke later: some browsers start reading the object URL asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saves text content (logs, generated sources) as a file. */
export function saveText(text: string, filename: string, mime = 'text/plain;charset=utf-8'): void {
  saveBlob(new Blob([text], { type: mime }), filename);
}

/** Replaces characters that are invalid in file names on Windows/macOS/Linux. */
export function sanitizeFilename(name: string, fallback = 'download'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
  const trimmed = cleaned.replace(/^\.+/, '').slice(0, 150);
  return trimmed || fallback;
}

/** Extracts the file name from a Content-Disposition header (RFC 6266 / 5987). */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  if (plain) return (plain[2] ?? plain[1] ?? '').trim() || null;
  return null;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

/** Fetches `path` as a Blob and saves it. Resolves with the file name used. */
async function downloadPath(
  path: string,
  fallbackName: string,
  opts?: DownloadOptions,
  query?: Record<string, QueryValue>,
): Promise<string> {
  return apiRequest(
    path,
    { ...opts, method: 'GET', query, timeoutMs: opts?.timeoutMs ?? TIMEOUTS.transfer },
    async (res) => {
      const blob = await res.blob();
      const name = sanitizeFilename(
        opts?.filename ??
          filenameFromContentDisposition(res.headers.get('Content-Disposition')) ??
          fallbackName,
        fallbackName,
      );
      saveBlob(blob, name);
      return name;
    },
  );
}

const REPORT_EXT: Record<ReportFormat, string> = { json: 'json', markdown: 'md', html: 'html' };

/* ============================================================================ endpoint groups */

const system = {
  /** GET /api/health */
  health: (opts?: RequestOptions) => get<HealthResponse>('/health', opts),
  /** GET /api/system/status - toolchain versions, sandbox description, AI configuration. */
  status: (opts?: RequestOptions) => get<SystemStatus>('/system/status', opts),
};

const examples = {
  /** GET /api/examples */
  list: (opts?: RequestOptions) => get<Example[]>('/examples', opts),
  /** POST /api/examples/{key}/instantiate - fresh project copy of a verified example. */
  instantiate: (key: string, opts?: RequestOptions) =>
    send<ProjectDetail>('POST', `/examples/${encodeURIComponent(key)}/instantiate`, {}, opts),
};

const projects = {
  /** GET /api/projects */
  list: (opts?: RequestOptions) => get<Project[]>('/projects', opts),
  /** POST /api/projects */
  create: (body: CreateProjectRequest, opts?: RequestOptions) =>
    send<ProjectDetail>('POST', '/projects', body, opts),
  /** GET /api/projects/{pid} */
  get: (pid: number, opts?: RequestOptions) => get<ProjectDetail>(`/projects/${pid}`, opts),
  /** PATCH /api/projects/{pid} */
  update: (pid: number, body: UpdateProjectRequest, opts?: RequestOptions) =>
    send<ProjectDetail>('PATCH', `/projects/${pid}`, body, opts),
  /** DELETE /api/projects/{pid} */
  remove: (pid: number, opts?: RequestOptions) =>
    apiRequest<OkResponse>(`/projects/${pid}`, { ...opts, method: 'DELETE' }),
  /** GET /api/projects/{pid}/export - the bundle as an object. */
  exportBundle: (pid: number, opts?: RequestOptions) =>
    get<ProjectBundle>(`/projects/${pid}/export`, {
      ...opts,
      timeoutMs: opts?.timeoutMs ?? TIMEOUTS.transfer,
    }),
  /** Exports the project and saves `<name>.silicongpt.json`. Resolves with the file name. */
  downloadExport: async (pid: number, opts?: DownloadOptions): Promise<string> => {
    const bundle = await projects.exportBundle(pid, opts);
    const name = sanitizeFilename(
      opts?.filename ?? `${slug(bundle.project?.name ?? `project-${pid}`)}.silicongpt.json`,
    );
    saveText(JSON.stringify(bundle, null, 2), name, 'application/json');
    return name;
  },
  /** POST /api/projects/import (bundle) */
  importBundle: (bundle: ProjectBundle, opts?: RequestOptions) =>
    send<ProjectDetail>('POST', '/projects/import', bundle, opts, TIMEOUTS.transfer),
  /** Reads a user-selected bundle file, parses it and imports it. */
  importFile: async (file: Blob & { name?: string }, opts?: RequestOptions): Promise<ProjectDetail> => {
    const label = file.name || 'The selected file';
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      throw new ApiError({ status: 0, kind: 'parse', detail: `Could not read ${label}: ${errorMessage(err)}` });
    }
    let bundle: unknown;
    try {
      bundle = JSON.parse(text);
    } catch {
      throw new ApiError({
        status: 0,
        kind: 'parse',
        detail: `${label} is not valid JSON (expected a "silicongpt-project/v1" bundle exported by SiliconGPT).`,
      });
    }
    return projects.importBundle(bundle as ProjectBundle, opts);
  },
  /** GET /api/projects/{pid}/hierarchy */
  hierarchy: (pid: number, opts?: RequestOptions) => get<Hierarchy>(`/projects/${pid}/hierarchy`, opts),
};

const files = {
  /** GET /api/projects/{pid}/files */
  list: (pid: number, opts?: RequestOptions) => get<FileMeta[]>(`/projects/${pid}/files`, opts),
  /** POST /api/projects/{pid}/files (kind inferred by the backend when omitted). */
  create: (pid: number, body: CreateFileRequest, opts?: RequestOptions) =>
    send<ProjectFile>('POST', `/projects/${pid}/files`, body, opts),
  /** POST /api/projects/{pid}/files/upload - multipart field "files" (.v .sv .vh .svh .hex .mem). */
  upload: (pid: number, selected: File[] | FileList, opts?: RequestOptions) => {
    const form = new FormData();
    for (const file of Array.from(selected)) form.append('files', file, file.name);
    return apiRequest<ProjectFile[]>(`/projects/${pid}/files/upload`, {
      ...opts,
      method: 'POST',
      form,
      timeoutMs: opts?.timeoutMs ?? TIMEOUTS.transfer,
    });
  },
  /** GET /api/projects/{pid}/files/{fid} */
  get: (pid: number, fid: number, opts?: RequestOptions) =>
    get<ProjectFile>(`/projects/${pid}/files/${fid}`, opts),
  /** PUT /api/projects/{pid}/files/{fid} - saves content (old content becomes a revision). */
  save: (pid: number, fid: number, body: SaveFileRequest, opts?: RequestOptions) =>
    send<ProjectFile>('PUT', `/projects/${pid}/files/${fid}`, body, opts),
  /** PATCH /api/projects/{pid}/files/{fid} - rename / change kind. */
  update: (pid: number, fid: number, body: UpdateFileMetaRequest, opts?: RequestOptions) =>
    send<ProjectFile>('PATCH', `/projects/${pid}/files/${fid}`, body, opts),
  /** DELETE /api/projects/{pid}/files/{fid} */
  remove: (pid: number, fid: number, opts?: RequestOptions) =>
    apiRequest<OkResponse>(`/projects/${pid}/files/${fid}`, { ...opts, method: 'DELETE' }),
  /** GET /api/projects/{pid}/files/{fid}/revisions */
  revisions: (pid: number, fid: number, opts?: RequestOptions) =>
    get<RevisionMeta[]>(`/projects/${pid}/files/${fid}/revisions`, opts),
  /** GET /api/projects/{pid}/files/{fid}/revisions/{rid} */
  revision: (pid: number, fid: number, rid: number, opts?: RequestOptions) =>
    get<RevisionDetail>(`/projects/${pid}/files/${fid}/revisions/${rid}`, opts),
  /** POST /api/projects/{pid}/files/{fid}/revert/{rid} */
  revert: (pid: number, fid: number, rid: number, opts?: RequestOptions) =>
    send<ProjectFile>('POST', `/projects/${pid}/files/${fid}/revert/${rid}`, {}, opts),
  /** POST /api/projects/{pid}/files/{fid}/format - conservative re-indent (reason "format"). */
  format: (pid: number, fid: number, opts?: RequestOptions) =>
    send<ProjectFile>('POST', `/projects/${pid}/files/${fid}/format`, {}, opts),
};

const simulation = {
  /** POST /api/projects/{pid}/lint - real Verilator --lint-only / iverilog -t null. */
  lint: (pid: number, body: LintRequest = {}, opts?: RequestOptions) =>
    send<LintResult>('POST', `/projects/${pid}/lint`, body, opts, TIMEOUTS.tool),
  /** POST /api/projects/{pid}/compile */
  compile: (pid: number, body: CompileRequest = {}, opts?: RequestOptions) =>
    send<CompileOutcome>('POST', `/projects/${pid}/compile`, body, opts, TIMEOUTS.tool),
  /** POST /api/projects/{pid}/simulate - runs the simulator and persists the run. */
  simulate: (pid: number, body: SimulateRequest = {}, opts?: RequestOptions) =>
    send<RunDetail>('POST', `/projects/${pid}/simulate`, body, opts, TIMEOUTS.tool),
  /** POST /api/projects/{pid}/inject-bug (example projects only). */
  injectBug: (pid: number, bugId: string, opts?: RequestOptions) =>
    send<InjectBugResult>('POST', `/projects/${pid}/inject-bug`, { bug_id: bugId }, opts),
};

const runs = {
  /** GET /api/projects/{pid}/runs */
  list: (pid: number, opts?: RequestOptions) => get<RunSummary[]>(`/projects/${pid}/runs`, opts),
  /** GET /api/runs/{rid} */
  get: (rid: number, opts?: RequestOptions) => get<RunDetail>(`/runs/${rid}`, opts),
  /** URL of the raw VCD (GET /api/runs/{rid}/vcd), e.g. for an <a href download>. */
  vcdUrl: (rid: number) => buildUrl(`/runs/${rid}/vcd`),
  /** Downloads the run's VCD file. Resolves with the file name used. */
  downloadVcd: (rid: number, opts?: DownloadOptions) =>
    downloadPath(`/runs/${rid}/vcd`, `silicongpt-run-${rid}.vcd`, opts),
};

const waveform = {
  /** GET /api/runs/{rid}/waveform/signals */
  signals: (rid: number, opts?: RequestOptions) =>
    get<WaveSignalList>(`/runs/${rid}/waveform/signals`, {
      ...opts,
      timeoutMs: opts?.timeoutMs ?? TIMEOUTS.transfer,
    }),
  /** POST /api/runs/{rid}/waveform/data - value changes of `signals` in [start, end]. */
  data: (rid: number, body: WaveformDataRequest, opts?: RequestOptions) =>
    send<WaveWindow>('POST', `/runs/${rid}/waveform/data`, body, opts, TIMEOUTS.transfer),
  /** GET /api/runs/{rid}/waveform/sample?t=&signals=a,b - values at time t. */
  sample: (rid: number, t: number, signals?: string[], opts?: RequestOptions) =>
    get<WaveSample>(`/runs/${rid}/waveform/sample`, opts, {
      t,
      signals: signals && signals.length ? signals.join(',') : undefined,
    }),
};

const synthesis = {
  /** POST /api/projects/{pid}/synthesize - real Yosys synthesis. */
  run: (pid: number, body: SynthesizeRequest = {}, opts?: RequestOptions) =>
    send<SynthRun>('POST', `/projects/${pid}/synthesize`, body, opts, TIMEOUTS.tool),
  /** GET /api/projects/{pid}/synth-runs */
  list: (pid: number, opts?: RequestOptions) => get<SynthRun[]>(`/projects/${pid}/synth-runs`, opts),
};

const reports = {
  /** GET /api/projects/{pid}/report?format=json */
  json: (pid: number, opts?: RequestOptions) =>
    get<ProjectReport>(`/projects/${pid}/report`, { ...opts, timeoutMs: opts?.timeoutMs ?? TIMEOUTS.tool }, {
      format: 'json',
    }),
  /** GET /api/projects/{pid}/report?format=markdown (text). */
  markdown: (pid: number, opts?: RequestOptions) =>
    apiRequest(
      `/projects/${pid}/report`,
      { ...opts, query: { format: 'markdown' }, timeoutMs: opts?.timeoutMs ?? TIMEOUTS.tool },
      readText,
    ),
  /** GET /api/projects/{pid}/report?format=html (standalone HTML document text). */
  html: (pid: number, opts?: RequestOptions) =>
    apiRequest(
      `/projects/${pid}/report`,
      { ...opts, query: { format: 'html' }, timeoutMs: opts?.timeoutMs ?? TIMEOUTS.tool },
      readText,
    ),
  /** Report URL, e.g. to open the HTML report in a new tab. */
  url: (pid: number, format: ReportFormat) => buildUrl(`/projects/${pid}/report`, { format }),
  /** Downloads the report in the given format. Resolves with the file name used. */
  download: (pid: number, format: ReportFormat, opts?: DownloadOptions) =>
    downloadPath(
      `/projects/${pid}/report`,
      `silicongpt-report-project-${pid}.${REPORT_EXT[format]}`,
      { ...opts, timeoutMs: opts?.timeoutMs ?? TIMEOUTS.tool },
      { format },
    ),
};

const dashboard = {
  /** GET /api/dashboard */
  get: (opts?: RequestOptions) => get<DashboardData>('/dashboard', opts),
};

const ai = {
  /** POST /api/ai/explain */
  explain: (body: ExplainRequest, opts?: RequestOptions) =>
    send<ExplainResponse>('POST', '/ai/explain', body, opts, TIMEOUTS.ai),
  /** POST /api/ai/generate-rtl - architect -> developer -> real compile/lint (+ repairs). */
  generateRtl: (body: GenerateRtlRequest, opts?: RequestOptions) =>
    send<GenerateRtlResponse>('POST', '/ai/generate-rtl', body, opts, TIMEOUTS.ai),
  /** POST /api/ai/generate-testbench - [SGPT]-protocol TB, compiled for real (+ repairs). */
  generateTestbench: (body: GenerateTestbenchRequest, opts?: RequestOptions) =>
    send<GenerateTestbenchResponse>('POST', '/ai/generate-testbench', body, opts, TIMEOUTS.ai),
  /** POST /api/ai/analyze-run */
  analyzeRun: (runId: number, opts?: RequestOptions) =>
    send<AnalyzeRunResponse>('POST', '/ai/analyze-run', { run_id: runId }, opts, TIMEOUTS.ai),
  /** POST /api/ai/debug - diagnosis + patches + pre-validation simulation. */
  debug: (runId: number, opts?: RequestOptions) =>
    send<DebugResponse>('POST', '/ai/debug', { run_id: runId }, opts, TIMEOUTS.ai),
  /** POST /api/ai/debug/{interaction_id}/apply {paths?} (reason "ai_patch"). */
  applyDebug: (interactionId: number, paths?: string[], opts?: RequestOptions) =>
    send<ApplyPatchesResponse>(
      'POST',
      `/ai/debug/${interactionId}/apply`,
      paths ? { paths } : {},
      opts,
    ),
  /** POST /api/ai/optimize - baseline synth -> optimizer -> re-synth -> TB regression. */
  optimize: (body: OptimizeRequest, opts?: RequestOptions) =>
    send<OptimizeResponse>('POST', '/ai/optimize', body, opts, TIMEOUTS.ai),
  /** POST /api/ai/optimize/{interaction_id}/apply {paths?} */
  applyOptimize: (interactionId: number, paths?: string[], opts?: RequestOptions) =>
    send<ApplyPatchesResponse>(
      'POST',
      `/ai/optimize/${interactionId}/apply`,
      paths ? { paths } : {},
      opts,
    ),
  /** POST /api/ai/ask */
  ask: (body: AskRequest, opts?: RequestOptions) =>
    send<AskResponse>('POST', '/ai/ask', body, opts, TIMEOUTS.ai),
  /** GET /api/projects/{pid}/ai-history */
  history: (pid: number, opts?: RequestOptions) => get<AIRecord[]>(`/projects/${pid}/ai-history`, opts),
  /** GET /api/ai/interactions/{iid} - record + stored request/response. */
  interaction: (iid: number, opts?: RequestOptions) =>
    get<AIInteractionDetail>(`/ai/interactions/${iid}`, opts),
};

/** All endpoints, grouped by area: `api.<group>.<method>()`. */
export const api = {
  system,
  examples,
  projects,
  files,
  simulation,
  runs,
  waveform,
  synthesis,
  reports,
  dashboard,
  ai,
} as const;

export type Api = typeof api;
