/**
 * AI testbench generation (fe-verify): POST /api/ai/generate-testbench. The verification agent
 * writes an [SGPT]-protocol testbench for a DUT module; the backend compiles it for real and
 * feeds compiler errors back for repair iterations. Shows the test plan, the planned coverage
 * bins, the code (read-only Monaco), the real compile result and the repairs.
 *
 * Saving: the request's `save` flag makes the backend write the testbench (only when it
 * compiles; into the file that already declares the testbench top, else a new file) and set the
 * project's testbench top - its `save_note` is shown verbatim. A testbench generated without
 * the flag can be saved afterwards with the same target rules through the files API
 * (POST / PUT /files) plus PATCH /projects {tb_top}; the plan is shown before saving.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CircleCheck,
  CircleX,
  Download,
  FileCode,
  FlaskConical,
  ListChecks,
  Play,
  Save,
  ScrollText,
  Sparkles,
  Target,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { api, errorMessage, isAbortError, saveText } from '../../services/api';
import type {
  FileMeta,
  GeneratedTestbench,
  GenerateTestbenchResponse,
  Hierarchy,
  ProjectDetail,
  ProjectFile,
  Simulator,
} from '../../services/types';
import { SIMULATORS } from '../../services/types';
import { formatDuration, formatNumber, humanize, simulatorLabel } from '../../lib/format';
import { simulatorAvailability } from '../../lib/system';
import { useProject } from '../../state/ProjectContext';
import { CodeEditor } from '../../editor/CodeEditor';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { EmptyState } from '../ui/EmptyState';
import { ErrorBanner } from '../ui/ErrorBanner';
import { Select } from '../ui/Select';
import { Spinner } from '../ui/Spinner';
import { Tabs } from '../ui/Tabs';
import { TextArea } from '../ui/TextArea';
import { useToast } from '../ui/Toast';
import { DiagnosticsList } from '../run/DiagnosticsList';
import { LogViewer } from '../run/LogViewer';
import { AIMeta, asRecord, asString, normalizeTestbench, repairsOf, responseNotes } from './ai';
import { editorPath, findProjectFile, formatElapsed, useElapsed } from './runData';

type ResultTab = 'code' | 'plan' | 'bins' | 'compile' | 'repairs' | 'notes';

interface DoneJob {
  status: 'done';
  response: GenerateTestbenchResponse;
  testbench: GeneratedTestbench;
  /** The request was sent with save=true. */
  savedRequested: boolean;
  /** Backend explanation of the save step ("Saved as ..." / "Not saved: ..."), when save=true. */
  saveNote: string;
}

type JobState = { status: 'idle' } | { status: 'running' } | { status: 'error'; error: unknown } | DoneJob;

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; file: ProjectFile; note: string }
  | { status: 'error'; error: unknown };

type SavePlan =
  | { mode: 'create'; text: string }
  | { mode: 'replace'; file: FileMeta; text: string }
  | { mode: 'blocked'; text: string };

/** Module names declared in Verilog / SystemVerilog source (comments and strings ignored). */
function declaredModules(source: string): Set<string> {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const names = new Set<string>();
  for (const m of code.matchAll(/(?:^|[\s;])(?:macro)?module\s+(?:automatic\s+|static\s+)?([A-Za-z_][A-Za-z0-9_$]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

/** Where an unsaved testbench would be written (mirrors the backend's save rules). */
function planSave(project: ProjectDetail, hierarchy: Hierarchy | null, tb: GeneratedTestbench, compileOk: boolean): SavePlan {
  if (!compileOk) {
    return { mode: 'blocked', text: 'Only a testbench that compiles can be saved to the project (the backend applies the same rule).' };
  }
  const samePath = project.files.find((f) => f.path.toLowerCase() === tb.path.toLowerCase());
  if (samePath && samePath.kind !== 'tb') {
    return { mode: 'blocked', text: `'${samePath.path}' already exists as a ${samePath.kind} file.` };
  }
  let target: FileMeta | null = samePath ?? null;
  let reason = '';
  if (!target && tb.tb_top) {
    const declaring = hierarchy?.modules.find((m) => m.name === tb.tb_top);
    const file = declaring ? findProjectFile(project.files, declaring.file) : null;
    if (file && file.kind !== 'tb') {
      return { mode: 'blocked', text: `Module ${tb.tb_top} is already declared in ${file.path} (${file.kind} file); rename or remove it first.` };
    }
    if (file) {
      target = file;
      reason = `, which already declares module ${tb.tb_top}`;
    }
  }
  // Every module of the new testbench must be new to the files it is compiled with (the target
  // file is replaced, so its own modules do not count): otherwise the project no longer compiles.
  const newModules = declaredModules(tb.content);
  const clash = (hierarchy?.modules ?? [])
    .filter((m) => newModules.has(m.name))
    .filter((m) => {
      const owner = findProjectFile(project.files, m.file);
      return !target || !owner || owner.id !== target.id;
    })
    .map((m) => `${m.name} (${m.file})`);
  if (clash.length > 0) {
    return {
      mode: 'blocked',
      text: `Module${clash.length === 1 ? '' : 's'} ${[...new Set(clash)].join(', ')} ${clash.length === 1 ? 'is' : 'are'} already declared in other project files; rename or remove ${clash.length === 1 ? 'it' : 'them'} first.`,
    };
  }
  if (target) {
    return {
      mode: 'replace',
      file: target,
      text: `Replaces the existing testbench ${target.path}${reason} (its current content is kept as a revision)`,
    };
  }
  return { mode: 'create', text: `Creates the testbench file ${tb.path}` };
}

export interface TestbenchGeneratorProps {
  project: ProjectDetail;
  /** Runs the project's simulation (the Verification Lab's "Run regression"). */
  onRunRegression?: () => void;
  regressionRunning?: boolean;
}

export function TestbenchGenerator({ project, onRunRegression, regressionRunning = false }: TestbenchGeneratorProps) {
  const { simulator: projectSimulator, systemStatus, refresh, setActiveFileId } = useProject();
  const toast = useToast();
  const navigate = useNavigate();

  const [spec, setSpec] = useState(project.spec ?? '');
  const [dut, setDut] = useState<string>('');
  const [simulator, setSimulator] = useState<Simulator>(projectSimulator);
  const [save, setSave] = useState(false);
  const [job, setJob] = useState<JobState>({ status: 'idle' });
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [tab, setTab] = useState<ResultTab>('code');
  const [topBusy, setTopBusy] = useState(false);
  const elapsed = useElapsed(job.status === 'running');

  /* ---- hierarchy (DUT candidates, save targets) ---- */
  const filesKey = project.files.map((f) => `${f.id}:${f.updated_at}`).join('|');
  const [hierarchy, setHierarchy] = useState<{ data: Hierarchy | null; loading: boolean; error: unknown }>({
    data: null,
    loading: true,
    error: null,
  });
  const [hierNonce, setHierNonce] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHierarchy((h) => ({ ...h, loading: true, error: null }));
    api.projects.hierarchy(project.id, { signal: controller.signal }).then(
      (data) => setHierarchy({ data, loading: false, error: null }),
      (err: unknown) => {
        if (!isAbortError(err)) setHierarchy({ data: null, loading: false, error: err });
      },
    );
    return () => controller.abort();
  }, [project.id, filesKey, hierNonce]);

  const modules = useMemo(() => (hierarchy.data?.modules ?? []).filter((m) => !m.is_testbench), [hierarchy.data]);
  useEffect(() => {
    if (!hierarchy.data) return;
    setDut((current) => {
      if (current && modules.some((m) => m.name === current)) return current;
      const preferred = hierarchy.data?.top_module ?? hierarchy.data?.suggested_top ?? null;
      if (preferred && modules.some((m) => m.name === preferred)) return preferred;
      return modules[0]?.name ?? '';
    });
  }, [hierarchy.data, modules]);
  const dutInfo = modules.find((m) => m.name === dut) ?? null;

  useEffect(() => {
    setSimulator(projectSimulator);
  }, [projectSimulator]);
  const availability = simulatorAvailability(systemStatus);
  const aiConfigured = systemStatus ? systemStatus.ai?.configured : null;

  /* ---- generate ---- */
  const generate = async () => {
    const requestedSave = save;
    setJob({ status: 'running' });
    setSaveState({ status: 'idle' });
    try {
      const response = await api.ai.generateTestbench({
        project_id: project.id,
        spec: spec.trim() ? spec : undefined,
        dut_module: dut || undefined,
        simulator,
        save: requestedSave,
      });
      const testbench = normalizeTestbench(response?.testbench);
      if (!testbench) throw new Error('The generate-testbench response did not contain testbench code.');
      const saveNote = asString(asRecord(response)?.save_note);
      setJob({ status: 'done', response, testbench, savedRequested: requestedSave, saveNote });
      setTab('code');
      if (response.saved_file) {
        setSaveState({ status: 'saved', file: response.saved_file, note: saveNote || `Saved as ${response.saved_file.path}.` });
        toast.success('Testbench saved', saveNote || `${response.saved_file.path} was written to the project.`);
        await refresh();
      } else if (requestedSave && saveNote) {
        toast.warning('Testbench not saved', saveNote);
      }
    } catch (err) {
      if (isAbortError(err)) return;
      setJob({ status: 'error', error: err });
    }
  };

  /* ---- save afterwards (files API + tb_top) ---- */
  const saveToProject = async (testbench: GeneratedTestbench, plan: SavePlan) => {
    if (plan.mode === 'blocked') return;
    setSaveState({ status: 'saving' });
    try {
      const file =
        plan.mode === 'replace'
          ? await api.files.save(project.id, plan.file.id, { content: testbench.content, reason: 'ai_testbench' })
          : await api.files.create(project.id, { path: testbench.path, content: testbench.content, kind: 'tb' });
      let note =
        plan.mode === 'replace'
          ? `Saved into ${file.path}; the previous content is kept as a file revision.`
          : `Saved as new testbench file ${file.path}.`;
      if (testbench.tb_top && project.tb_top !== testbench.tb_top) {
        try {
          await api.projects.update(project.id, { tb_top: testbench.tb_top });
          note += ` Project testbench top set to ${testbench.tb_top}.`;
        } catch (err) {
          note += ` The project testbench top could not be changed: ${errorMessage(err)}`;
        }
      }
      setSaveState({ status: 'saved', file, note });
      toast.success('Testbench saved', note);
      await refresh();
    } catch (err) {
      setSaveState({ status: 'error', error: err });
    }
  };

  const useAsTbTop = async (tbTop: string) => {
    setTopBusy(true);
    try {
      await api.projects.update(project.id, { tb_top: tbTop });
      await refresh();
      setHierNonce((n) => n + 1);
      toast.success('Testbench top updated', `Simulations of this project now use ${tbTop}.`);
    } catch (err) {
      toast.error('Could not update the testbench top', err);
    } finally {
      setTopBusy(false);
    }
  };

  const openInEditor = (file: ProjectFile) => {
    setActiveFileId(file.id);
    navigate(editorPath(file.id));
  };

  const running = job.status === 'running';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      {/* ------------------------------------------------------------ form */}
      <Card
        icon={<FlaskConical />}
        title="AI testbench generation"
        description="Verification agent + real compile with repair iterations"
        className="self-start"
      >
        <div className="flex flex-col gap-3.5">
          <TextArea
            label="Specification"
            hint="Defaults to the project specification. The agent derives the test plan and the reference model from it."
            rows={8}
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder="Describe the module's behaviour, interfaces and corner cases…"
            disabled={running}
            labelAction={`${formatNumber(spec.length)} chars`}
          />

          <Select
            label="Design under test"
            value={dut}
            onChange={(e) => setDut(e.target.value)}
            disabled={running || hierarchy.loading}
            hint={
              hierarchy.loading
                ? 'Reading the module hierarchy…'
                : modules.length === 0
                  ? 'No RTL module was found in the project files.'
                  : 'Modules parsed from the project RTL (GET /hierarchy).'
            }
          >
            <option value="">Auto-detect (the project's design top)</option>
            {modules.map((m) => (
              <option key={`${m.file}:${m.name}`} value={m.name}>
                {m.name} ({m.file}
                {m.is_sequential ? ', sequential' : ''})
              </option>
            ))}
          </Select>
          {hierarchy.error ? (
            <ErrorBanner error={hierarchy.error} title="Could not read the hierarchy" onRetry={() => setHierNonce((n) => n + 1)} />
          ) : null}
          {dutInfo && (
            <div className="flex flex-wrap gap-1.5 text-2xs">
              <Badge size="xs" tone="neutral">
                {formatNumber(dutInfo.ports.filter((p) => p.direction === 'input').length)} inputs
              </Badge>
              <Badge size="xs" tone="neutral">
                {formatNumber(dutInfo.ports.filter((p) => p.direction === 'output').length)} outputs
              </Badge>
              {dutInfo.clocks.map((c) => (
                <Badge key={c} size="xs" mono tone="blue">
                  clk {c}
                </Badge>
              ))}
              {dutInfo.resets.map((r) => (
                <Badge key={r.name} size="xs" mono tone="violet">
                  rst {r.name}
                  {r.active_low ? ' (active low)' : ''}
                </Badge>
              ))}
              {dutInfo.params.length > 0 && (
                <Badge size="xs" tone="neutral">
                  {formatNumber(dutInfo.params.length)} params
                </Badge>
              )}
            </div>
          )}

          <Select
            label="Simulator for the compile check"
            value={simulator}
            onChange={(e) => setSimulator(e.target.value === 'verilator' ? 'verilator' : 'icarus')}
            disabled={running}
            hint={availability[simulator].reason ?? 'The generated testbench is compiled with this simulator.'}
            options={SIMULATORS.map((s) => ({
              value: s,
              label: `${simulatorLabel(s)}${availability[s].available ? '' : ' (unavailable)'}`,
              disabled: !availability[s].available && s !== simulator,
            }))}
          />

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5">
            <input
              type="checkbox"
              checked={save}
              disabled={running}
              onChange={(e) => setSave(e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
            />
            <span className="text-xs leading-5">
              <span className="font-medium text-text">Save to project</span>
              <span className="block text-muted">
                When the testbench compiles, the backend writes it into the project and makes it the project's testbench
                top (the request's save flag).
              </span>
            </span>
          </label>

          {aiConfigured === false && (
            <p className="text-xs text-[#fcd34d]">
              Claude API credentials are not configured on the backend: generation will be rejected (HTTP 503) until
              they are.
            </p>
          )}

          <Button variant="primary" icon={<Sparkles />} loading={running} onClick={() => void generate()} fullWidth>
            {running ? 'Generating…' : 'Generate testbench'}
          </Button>
          <p className="text-2xs leading-4 text-subtle">
            The agent follows the [SGPT] testbench protocol (independent reference model, CHECK / COVER / SUMMARY /
            DONE records, watchdog). Repairs only fix compile errors; they never weaken checks.
          </p>
        </div>
      </Card>

      {/* ------------------------------------------------------------ result */}
      <div className="flex min-w-0 flex-col gap-4">
        {job.status === 'idle' && (
          <Card>
            <EmptyState
              icon={<FlaskConical />}
              title="No testbench generated yet"
              description={
                <>
                  Pick the design under test and generate. The backend compiles the testbench with{' '}
                  {simulatorLabel(simulator)} and feeds real compiler errors back to the agent for up to two repair
                  iterations. Nothing here is a simulated or invented result.
                </>
              }
              bordered={false}
            />
          </Card>
        )}

        {job.status === 'running' && (
          <Card>
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <Spinner size="lg" className="text-accent" />
              <p className="text-sm font-medium text-text">Generating and compiling the testbench… {formatElapsed(elapsed)}</p>
              <p className="max-w-md text-xs text-muted">
                Agent call, real {simulatorLabel(simulator)} compile and up to two repair iterations. AI workflows can take
                several minutes.
              </p>
            </div>
          </Card>
        )}

        {job.status === 'error' && (
          <ErrorBanner error={job.error} title="Testbench generation failed" onRetry={() => void generate()} />
        )}

        {job.status === 'done' && (
          <TestbenchResult
            project={project}
            job={job}
            plan={planSave(project, hierarchy.data, job.testbench, Boolean(job.response.compile?.ok))}
            tab={tab}
            onTab={setTab}
            saveState={saveState}
            onSave={(plan) => void saveToProject(job.testbench, plan)}
            onOpenInEditor={openInEditor}
            onUseAsTbTop={(top) => void useAsTbTop(top)}
            topBusy={topBusy}
            onRunRegression={onRunRegression}
            regressionRunning={regressionRunning}
          />
        )}
      </div>
    </div>
  );
}

/* ============================================================================ result */

interface TestbenchResultProps {
  project: ProjectDetail;
  job: DoneJob;
  plan: SavePlan;
  tab: ResultTab;
  onTab: (tab: ResultTab) => void;
  saveState: SaveState;
  onSave: (plan: SavePlan) => void;
  onOpenInEditor: (file: ProjectFile) => void;
  onUseAsTbTop: (tbTop: string) => void;
  topBusy: boolean;
  onRunRegression?: () => void;
  regressionRunning: boolean;
}

function TestbenchResult({
  project,
  job,
  plan,
  tab,
  onTab,
  saveState,
  onSave,
  onOpenInEditor,
  onUseAsTbTop,
  topBusy,
  onRunRegression,
  regressionRunning,
}: TestbenchResultProps) {
  const { response, testbench } = job;
  const compile = response.compile;
  const compileOk = Boolean(compile?.ok);
  const diagnostics = compile?.diagnostics ?? [];
  const violations = compile?.policy_violations ?? [];
  const repairs = repairsOf(response);
  const notes = [...responseNotes(response), ...testbench.notes];
  const dutModule = asString(asRecord(response)?.dut_module);
  const tbTopMismatch = Boolean(testbench.tb_top) && project.tb_top !== testbench.tb_top;

  return (
    <Card
      icon={<FileCode />}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{testbench.path}</span>
          {compile ? (
            compileOk ? (
              <Badge tone="pass" size="sm" icon={<CircleCheck />}>
                Compiles with {simulatorLabel(compile.simulator)}
              </Badge>
            ) : (
              <Badge tone="fail" size="sm" icon={<CircleX />}>
                Compile errors ({simulatorLabel(compile.simulator)})
              </Badge>
            )
          ) : (
            <Badge tone="neutral" size="sm">
              No compile result returned
            </Badge>
          )}
        </span>
      }
      description={
        <>
          {dutModule ? (
            <>
              DUT <span className="font-mono text-text">{dutModule}</span> ·{' '}
            </>
          ) : null}
          testbench top <span className="font-mono text-text">{testbench.tb_top || '—'}</span> ·{' '}
          {formatNumber(testbench.test_plan.length)} planned tests · {formatNumber(testbench.coverage_bins.length)} coverage
          bins · {formatNumber(repairs.count)} repair iteration{repairs.count === 1 ? '' : 's'}
          {compile ? ` · compile ${formatDuration(compile.duration_ms)}` : ''}
        </>
      }
      actions={
        <>
          <CopyButton text={testbench.content} label="Copy code" />
          <Button size="xs" variant="ghost" icon={<Download />} onClick={() => saveText(testbench.content, testbench.path)}>
            Download
          </Button>
        </>
      }
      footer={<AIMeta record={response.interaction} />}
    >
      <SaveBar
        project={project}
        job={job}
        plan={plan}
        compileOk={compileOk}
        saveState={saveState}
        onSave={onSave}
        onOpenInEditor={onOpenInEditor}
        tbTopMismatch={tbTopMismatch}
        onUseAsTbTop={onUseAsTbTop}
        topBusy={topBusy}
        onRunRegression={onRunRegression}
        regressionRunning={regressionRunning}
      />

      <Tabs<ResultTab>
        className="mt-3 overflow-y-hidden"
        aria-label="Generated testbench"
        value={tab}
        onChange={onTab}
        tabs={[
          { id: 'code', label: 'Testbench code', icon: <FileCode /> },
          { id: 'plan', label: 'Test plan', icon: <ListChecks />, badge: formatNumber(testbench.test_plan.length) },
          { id: 'bins', label: 'Coverage bins', icon: <Target />, badge: formatNumber(testbench.coverage_bins.length) },
          {
            id: 'compile',
            label: 'Compile result',
            icon: <ScrollText />,
            badge: diagnostics.length > 0 ? formatNumber(diagnostics.length) : undefined,
          },
          { id: 'repairs', label: 'Repairs', icon: <Wrench />, badge: formatNumber(repairs.count) },
          { id: 'notes', label: 'Notes', badge: notes.length > 0 ? formatNumber(notes.length) : undefined },
        ]}
      />

      <div className="pt-3">
        {tab === 'code' && (
          <div className="overflow-hidden rounded-lg border border-border">
            <CodeEditor value={testbench.content} path={testbench.path} readOnly markers={diagnostics} height={540} minimap={false} />
          </div>
        )}

        {tab === 'plan' &&
          (testbench.test_plan.length === 0 ? (
            <p className="text-xs text-subtle">The agent returned no test plan.</p>
          ) : (
            <div className="overflow-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="bg-panel text-2xs uppercase tracking-wider text-subtle">
                  <tr className="border-b border-border">
                    <th className="px-3 py-1.5 font-medium">Test</th>
                    <th className="px-3 py-1.5 font-medium">Category</th>
                    <th className="w-full px-3 py-1.5 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {testbench.test_plan.map((t, i) => (
                    <tr key={`${t.name}-${i}`} className="border-b border-border/60 align-top last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-text">{t.name}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-muted">{humanize(t.category)}</td>
                      <td className="px-3 py-1.5 leading-5 text-[#c3cede]">{t.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {tab === 'bins' && (
          <div className="flex flex-col gap-2">
            <p className="rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-5 text-muted">
              Planned functional-coverage bins. The testbench keeps a hit counter per bin and prints{' '}
              <code className="font-mono text-[#a5f3fc]">[SGPT] COVER</code> records; hit counts exist only after a
              simulation run and appear in that run's coverage panel.
            </p>
            {testbench.coverage_bins.length === 0 ? (
              <p className="text-xs text-subtle">The agent planned no coverage bins.</p>
            ) : (
              <div className="overflow-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-panel text-2xs uppercase tracking-wider text-subtle">
                    <tr className="border-b border-border">
                      <th className="px-3 py-1.5 font-medium">Bin</th>
                      <th className="px-3 py-1.5 font-medium">Group</th>
                      <th className="w-full px-3 py-1.5 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testbench.coverage_bins.map((b, i) => (
                      <tr key={`${b.group}-${b.name}-${i}`} className="border-b border-border/60 align-top last:border-b-0">
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-text">{b.name}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">{b.group || '—'}</td>
                        <td className="px-3 py-1.5 leading-5 text-[#c3cede]">{b.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'compile' &&
          (compile ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {compileOk ? (
                  <Badge tone="pass" size="sm" icon={<CircleCheck />}>
                    Compiled
                  </Badge>
                ) : (
                  <Badge tone="fail" size="sm" icon={<CircleX />}>
                    Did not compile
                  </Badge>
                )}
                <span>{simulatorLabel(compile.simulator)}</span>
                <span>· {formatDuration(compile.duration_ms)}</span>
                {compile.argv?.length > 0 && (
                  <code
                    className="min-w-0 max-w-full truncate rounded bg-surface px-1.5 py-0.5 font-mono text-2xs text-subtle"
                    title={compile.argv.join(' ')}
                  >
                    {compile.argv.join(' ')}
                  </code>
                )}
              </div>
              {violations.length > 0 && (
                <ul className="flex flex-col gap-1 rounded-lg border border-violet/30 bg-violet/[0.04] px-3 py-2">
                  {violations.map((v, i) => (
                    <li key={i} className="text-xs text-text">
                      <Badge tone="violet" size="xs" mono>
                        {v.rule}
                      </Badge>{' '}
                      <span className="font-mono text-2xs text-muted">
                        {v.file}:{v.line}
                      </span>{' '}
                      {v.message}
                    </li>
                  ))}
                </ul>
              )}
              <DiagnosticsList diagnostics={diagnostics} maxHeight={220} emptyText="The compiler reported no diagnostics." />
              <LogViewer
                text={compile.log}
                title="Compiler output"
                height={260}
                emptyText="The compiler printed nothing."
                downloadName={`${testbench.path}.compile.log`}
              />
            </div>
          ) : (
            <p className="text-xs text-subtle">The backend returned no compile result for this testbench.</p>
          ))}

        {tab === 'repairs' && <RepairList count={repairs.count} items={repairs.items} compileOk={compileOk} />}

        {tab === 'notes' &&
          (notes.length === 0 ? (
            <p className="text-xs text-subtle">No notes were returned.</p>
          ) : (
            <ul className="ml-4 list-disc space-y-1 text-xs leading-5 text-[#c3cede]">
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ))}
      </div>
    </Card>
  );
}

function RepairList({ count, items, compileOk }: { count: number; items: Array<Record<string, unknown>>; compileOk: boolean }) {
  if (count === 0) {
    return <p className="text-xs text-subtle">No repair iteration was needed{compileOk ? ': the first version compiled.' : '.'}</p>;
  }
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted">
        The backend reports {formatNumber(count)} repair iteration{count === 1 ? '' : 's'} (each fed with the real
        compiler log); it returned no per-iteration details.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {items.map((it, i) => {
        const changes = Array.isArray(it.changes) ? it.changes.map(asString).filter((c) => c.trim()) : [];
        const log = asString(it.compile_log ?? it.log);
        const before = typeof it.errors_before === 'number' ? it.errors_before : null;
        const after = typeof it.errors_after === 'number' ? it.errors_after : null;
        return (
          <li key={i} className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-text">Repair {typeof it.iteration === 'number' ? it.iteration : i + 1}</span>
              {before !== null && (
                <span className="text-2xs text-muted">
                  {formatNumber(before)} compile error{before === 1 ? '' : 's'} fed to the agent
                  {after !== null ? ` · ${formatNumber(after)} after the repair` : ''}
                </span>
              )}
              {typeof it.compile_ok === 'boolean' &&
                (it.compile_ok ? (
                  <Badge tone="pass" size="xs">
                    compiled afterwards
                  </Badge>
                ) : (
                  <Badge tone="fail" size="xs">
                    still failing
                  </Badge>
                ))}
            </div>
            {changes.length > 0 ? (
              <ul className="ml-4 mt-1 list-disc space-y-0.5 text-xs leading-5 text-[#c3cede]">
                {changes.map((c, j) => (
                  <li key={j}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-2xs text-subtle">No change summary returned.</p>
            )}
            {log.trim() && (
              <details className="mt-1.5">
                <summary className="text-2xs text-muted">Compiler log fed to this repair</summary>
                <pre className="mt-1 max-h-56 overflow-auto rounded bg-bg/60 px-2 py-1.5 font-mono text-2xs text-[#c3cede]">{log}</pre>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}

interface SaveBarProps {
  project: ProjectDetail;
  job: DoneJob;
  plan: SavePlan;
  compileOk: boolean;
  saveState: SaveState;
  onSave: (plan: SavePlan) => void;
  onOpenInEditor: (file: ProjectFile) => void;
  tbTopMismatch: boolean;
  onUseAsTbTop: (tbTop: string) => void;
  topBusy: boolean;
  onRunRegression?: () => void;
  regressionRunning: boolean;
}

function SaveBar({
  project,
  job,
  plan,
  compileOk,
  saveState,
  onSave,
  onOpenInEditor,
  tbTopMismatch,
  onUseAsTbTop,
  topBusy,
  onRunRegression,
  regressionRunning,
}: SaveBarProps) {
  const { testbench } = job;
  return (
    <div className="flex flex-col gap-2">
      {!compileOk && (
        <p className="flex items-start gap-2 rounded-lg border border-fail/30 bg-fail/[0.05] px-3 py-2 text-xs text-[#fecaca]">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fail" />
          The testbench still does not compile after the repair iterations. See the compile result.
        </p>
      )}

      {saveState.status === 'saved' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-pass/30 bg-pass/[0.05] px-3 py-2 text-xs text-[#bbf7d0]">
          <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-pass" />
          <span className="min-w-0 flex-1">{saveState.note}</span>
          <span className="flex flex-wrap gap-2">
            <Button size="xs" variant="secondary" icon={<FileCode />} onClick={() => onOpenInEditor(saveState.file)}>
              Open in editor
            </Button>
            {onRunRegression && (
              <Button size="xs" variant="primary" icon={<Play />} loading={regressionRunning} onClick={onRunRegression}>
                Run regression
              </Button>
            )}
          </span>
        </div>
      ) : (
        <>
          {job.savedRequested && job.saveNote && (
            <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-xs text-[#fde68a]">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
              {job.saveNote}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
            <span className="min-w-0 flex-1">
              Not saved to the project.{' '}
              {plan.mode === 'blocked'
                ? plan.text
                : `Save: ${plan.text}${testbench.tb_top ? ` and sets the project testbench top to ${testbench.tb_top}` : ''}.`}
            </span>
            <Button
              size="xs"
              variant="secondary"
              icon={<Save />}
              loading={saveState.status === 'saving'}
              disabled={plan.mode === 'blocked'}
              onClick={() => onSave(plan)}
            >
              {plan.mode === 'replace' ? `Save into ${plan.file.path}` : 'Save to project'}
            </Button>
          </div>
        </>
      )}

      {saveState.status === 'error' && <ErrorBanner error={saveState.error} title="Could not save the testbench" />}

      {saveState.status === 'saved' && tbTopMismatch && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-xs text-[#fde68a]">
          <TriangleAlert aria-hidden="true" className="size-3.5 text-warn" />
          <span>
            Simulations use the project testbench top{' '}
            <span className="font-mono text-text">{project.tb_top ?? '(auto-detected)'}</span>; the new testbench's top is{' '}
            <span className="font-mono text-text">{testbench.tb_top}</span>.
          </span>
          <Button size="xs" variant="secondary" loading={topBusy} onClick={() => onUseAsTbTop(testbench.tb_top)} className="ml-auto">
            Use {testbench.tb_top} as testbench top
          </Button>
        </div>
      )}
    </div>
  );
}
