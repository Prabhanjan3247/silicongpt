# SiliconGPT frontend

Vite 8 + React 18 + TypeScript (strict) + Tailwind CSS v4 (`@tailwindcss/vite`) + react-router-dom 6 +
`@monaco-editor/react` with the **local** `monaco-editor` package (no CDN) + recharts + lucide-react +
react-markdown/remark-gfm + `@fontsource/inter` / `@fontsource/jetbrains-mono`. See `docs/CONTRACTS.md` section 6.

```bash
npm install
npm run typecheck   # tsc --noEmit (app) + tsc --noEmit -p tsconfig.node.json (vite.config.ts)
npm run build       # typecheck + vite build -> dist/
npm run dev         # http://localhost:5173, /api proxied to http://127.0.0.1:8000 (integration run only)
```

`monaco-editor` is pinned to **0.52.2**: it is the version `@monaco-editor/react` 4.7 targets, and its layout
supports the deep imports used here (`monaco-editor/esm/vs/editor/editor.worker?worker`). Releases 0.56+ ship
an `exports` map that breaks those paths.

## Layout

```
src/
  main.tsx, App.tsx          providers + routes (pages are lazy-loaded per route)
  routes.ts                  sidebar / top-bar registry (contract order)
  index.css                  Tailwind + design tokens (@theme static) + markdown / Monaco decoration styles
  theme/tokens.ts            the same tokens as JS values (Monaco theme, canvas, recharts) + chart palettes
  services/types.ts          TypeScript mirrors of every REST shape (CONTRACTS.md section 4)
  services/api.ts            api.<group>.<method>() for every endpoint, ApiError, downloads
  state/ProjectContext.tsx   useProject()
  lib/                       format.ts, status.ts, system.ts, lazyPage.ts, usePersistentState.ts
  components/ui/             primitives (import from '../components/ui')
  components/run/            run / verification widgets
  components/layout/         AppShell, Sidebar, TopBar, PageContainer, PageHeader, ...
  editor/                    monacoSetup.ts, CodeEditor.tsx, DiffViewer.tsx, editorUtils.ts
  pages/*Page.tsx            one module per route (stubs until the page owners replace them)
```

Page owners replace `src/pages/<Name>Page.tsx` and add their own files under `src/components/<area>/`,
`src/waveform/` and `src/editor/`. Do not fork the shared modules: if one needs a change, ask its owner.

## Pages

* Export the page component as the **default export** (a named export with the file name also works).
  App.tsx lazy-loads the module, so heavy dependencies (Monaco, recharts) only load with the pages that use them.
* Wrap content in `<PageContainer>` and start with `<PageHeader title description icon actions />`.
  Workspaces that manage their own scrolling (editor, waveform viewer) use `<PageContainer width="full" fill>`.
* Deep links: `/verification?run=<id>`, `/waveforms?run=<id>`, `/debugger?run=<id>` (`runPaths()` in
  components/run/RunLinks.tsx). Read them with `useSearchParams()`.
* Every button must call a real endpoint or navigate. Show real errors with `<ErrorBanner error={err} />`
  (it renders `ApiError.detail`, the HTTP status and a hint, e.g. for AI 503) or `useToast().error(title, err)`.

## services/api.ts

```ts
import { api, ApiError, errorMessage, isAbortError } from '../services/api';
const run = await api.simulation.simulate(projectId, { simulator });       // RunDetail
const res = await api.ai.debug(runId, { signal });                          // AI calls: 20 min timeout
await api.runs.downloadVcd(runId);                                          // browser download
```

Groups: `system` (health, status), `examples` (list, instantiate), `projects` (list, create, get, update, remove,
exportBundle, downloadExport, importBundle, importFile, hierarchy), `files` (list, create, upload, get, save [PUT],
update [PATCH], remove, revisions, revision, revert, format), `simulation` (lint, compile, simulate, injectBug),
`runs` (list, get, vcdUrl, downloadVcd), `waveform` (signals, data, sample), `synthesis` (run, list),
`reports` (json, markdown, html, url, download), `dashboard` (get), `ai` (explain, generateRtl, generateTestbench,
analyzeRun, debug, applyDebug, optimize, applyOptimize, ask, history, interaction).

Every method accepts a trailing `{ signal?, timeoutMs? }` and rejects with `ApiError { status, detail, kind }`
(status 0 = no HTTP response: kind `network` | `timeout` | `aborted` | `parse`). `apiRequest()` is exported for
endpoints that are not wrapped yet. `saveBlob` / `saveText` trigger browser downloads.

`services/types.ts` mirrors every contract shape. Where the real backend modules send more than the contract pins,
the extra keys are typed as optional (`WaveWindow.complete_until / missing / signals_capped`, `WaveSample.missing`,
`SynthStats.port_bits / stat_source`, ...). `api.reports.json()` returns `VerificationReport`, a mirror of
`services/report_service.py build_report()` (`latest_run`, `run_history`, `ai_debug_sessions`, `synthesis`,
`missing`, `verification_statement`, `limitations`, ...).

`lib/usePersistentState(key, initial)`: localStorage-backed state; when `key` changes (e.g. per project) it switches
to the value stored under the new key.

## useProject()

`projectId, setProjectId, openProject(detail), project, files, projectLoading, projectError, refresh,
activeFileId, setActiveFileId, activeFile, lastRun, setLastRun, simulator, setSimulator, projects,
projectsLoading, projectsError, refreshProjects, systemStatus, systemStatusLoading, systemStatusError,
refreshSystemStatus, examples, examplesLoading, examplesError, refreshExamples`.

* The selection is persisted in localStorage `sgpt.projectId`; the active file per project in `sgpt.activeFile.<id>`.
* `setSimulator()` persists the choice on the project (PATCH). Pass `simulator` to compile / simulate calls.
* After creating / importing / instantiating a project call `openProject(detail)`; after file or project
  changes call `refresh()`; after a run call `setLastRun(runDetail)`. After deleting the selected project
  call `setProjectId(null)` and `refreshProjects()`.
* `systemStatus` is re-checked in the background (every 60 s, when the tab becomes visible, every 10 s while
  it fails). `systemStatusError` is the latest failure (the status pills then show "Backend offline").
  When the backend answers again, project / project list / examples loads that failed are retried.

## Shared components

* `components/ui`: Button (`primary | secondary | ghost | danger`, `loading`, `icon`), ButtonLink, Card, Badge,
  StatusBadge (every RunStatus, plus `kind="synth"`), Tabs, Spinner / LoadingState, EmptyState, Modal, Select,
  TextArea, Input, Field, Markdown, KeyValue, CopyButton, ToastProvider / `useToast()`, ErrorBanner.
* `components/run`: LogViewer (virtualised, line numbers, search, `[SGPT]` / issue filters and colouring,
  `height="fill"` to fill a sized parent), ChecksTable, CoveragePanel ("testbench-reported functional coverage";
  explicit "not implemented by this testbench" state, never computes a number), DiagnosticsList, RunSummaryCard,
  RunHistoryTable, RunLinks.
* `editor`: `CodeEditor` (props `value, onChange, language, path, modelPath, readOnly, markers: Diagnostic[],
  markerFile, onMount(editor, monaco), onSave`), `DiffViewer` (`original, modified, language, path, labels`),
  `editorUtils` (`revealLine`, `highlightLines` -> decorations collection, `diagnosticsToMarkers`).
  * `value` is the source of truth: a reused Monaco model is re-synced to it (no `onChange` for that), and the
    models an editor showed are disposed when it unmounts. `onChange` fires for user edits only.
  * `onSave` is bound to Ctrl/Cmd+S of *that* editor (an editor-scoped action), so several editors on one page
    each save their own file. Pass `options` memoized (a new object re-applies the options).
  Need the Monaco API? `import { monaco } from '../editor/monacoSetup'`. Do **not** import the runtime
  `'monaco-editor'` package root (it bundles every language service); `import type * as Monaco from 'monaco-editor'`
  is fine.

## Design tokens

Tailwind utilities from `index.css`: `bg-bg`, `bg-surface`, `bg-panel`, `bg-raised`, `bg-hover`, `border-border`,
`border-border-strong`, `text-text`, `text-muted`, `text-subtle`, `text-accent`, `bg-blue`, `text-pass`,
`text-fail`, `text-warn`, `text-xstate`, `text-zstate`, `font-sans` (Inter), `font-mono` (JetBrains Mono),
`text-2xs`, `shadow-panel`, `shadow-pop`, `shadow-glow`. CSS variables: `var(--color-pass)` etc.
JS values: `tokens`, `fonts`, `statusChartColors`, `categoricalPalette` (validated for the dark panel
surface; assign in fixed order), `chartChrome` in `src/theme/tokens.ts`.

Hard rule: never fake tool output, simulation results, coverage numbers or waveforms in the UI.
