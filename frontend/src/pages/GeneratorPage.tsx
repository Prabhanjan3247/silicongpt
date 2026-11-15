/**
 * AI Generator (/generator): natural-language spec -> architect analysis -> RTL, compiled and
 * linted by the real tools on the backend (POST /api/ai/generate-rtl). The result can be
 * explained line by line (POST /api/ai/explain), written into a project and turned into a
 * self-checking testbench (POST /api/ai/generate-testbench). Long requests show their elapsed
 * time and keep running when you leave the page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, ChevronRight, FileCode, Hammer, Layers, ListChecks, ScanLine, Sparkles, TriangleAlert, Wrench } from 'lucide-react';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { AIJobProgress } from '../components/generator/AIJobProgress';
import { useJob } from '../components/generator/aiJobs';
import { ArchitecturePanel } from '../components/generator/ArchitecturePanel';
import { CompilePanel, WorkflowNotes, designDiagnostics } from '../components/generator/CompilePanel';
import { TestbenchResultPanel } from '../components/generator/TestbenchResultPanel';
import { ExplanationPanel, TestPlanPanel } from '../components/generator/DesignNotesPanel';
import {
  RTL_JOB,
  countDiagnostics,
  defaultFilePath,
  explainJobs,
  explainKey,
  generatorSession,
  normalizeDesign,
  rtlJobs,
  testbenchJobs,
  useGeneratorSession,
  type GeneratorSession,
} from '../components/generator/generatorStore';
import { ResultHeader } from '../components/generator/ResultHeader';
import { RtlFilesPanel } from '../components/generator/RtlFilesPanel';
import { SaveDesignModal, type SaveIntent, type SaveOutcome } from '../components/generator/SaveDesignModal';
import { SpecForm } from '../components/generator/SpecForm';
import { api } from '../services/api';
import type { HdlLanguage, Simulator } from '../services/types';
import { formatNumber, pluralize, simulatorLabel } from '../lib/format';
import { usePersistentState } from '../lib/usePersistentState';
import { useProject } from '../state/ProjectContext';

type ResultTab = 'architecture' | 'rtl' | 'compile' | 'explanation' | 'tests';

const RTL_STEPS = [
  'Architect agent: interfaces, control encoding, assumptions and open questions',
  'Developer agent: synthesizable RTL files, an explanation and a test plan',
  'Real compile of the RTL with Icarus Verilog (no testbench, top module elaborated)',
  'If it fails: up to 2 repair iterations, each fed with the real compiler log',
  'Verilator lint of the result',
] as const;

const PIPELINE = [
  { label: 'Architect', icon: Layers },
  { label: 'Developer', icon: FileCode },
  { label: 'Compile', icon: Hammer },
  { label: 'Repair ≤ 2', icon: Wrench },
  { label: 'Lint', icon: ScanLine },
] as const;

function testbenchSteps(simulator: Simulator): string[] {
  return [
    `Pre-check: the project RTL must compile on its own with ${simulatorLabel(simulator)}`,
    'Verification agent writes a self-checking testbench ([SGPT] protocol) for the top module',
    `Real compile of RTL + testbench with ${simulatorLabel(simulator)}`,
    'Up to 2 repairs of compile errors only (checks are never weakened)',
    'Saved into the project only if it compiles (it then becomes the project testbench)',
  ];
}

/** `save_note` of a generate-testbench response (why it was or was not saved). */
function saveNoteOf(response: unknown): string | null {
  const note = (response as { save_note?: unknown } | null)?.save_note;
  return typeof note === 'string' && note.trim() ? note : null;
}

function toSimulator(value: string | null | undefined): Simulator {
  return value === 'verilator' ? 'verilator' : 'icarus';
}

function repairCountOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Array.isArray(value) ? value.length : 0;
}

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function GeneratorPage() {
  const { project, projects, projectId, setProjectId, openProject, refresh, refreshProjects, systemStatus } = useProject();
  const navigate = useNavigate();
  const toast = useToast();

  const session = useGeneratorSession();
  const rtlJob = useJob(rtlJobs, RTL_JOB);
  const tbJob = useJob(testbenchJobs, session?.id ?? null);

  const [spec, setSpec] = usePersistentState<string>('sgpt.generator.spec', '');
  const [language, setLanguage] = usePersistentState<HdlLanguage>('sgpt.generator.language', 'verilog');
  const [linked, setLinked] = usePersistentState<{ id: number; name: string } | null>('sgpt.generator.linkedProject', null);
  const [tab, setTab] = useState<ResultTab>('architecture');
  const [activePath, setActivePath] = useState<string | null>(null);
  const [modal, setModal] = useState<SaveIntent | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // A new result: show its default file (the one named after the top module).
  const sessionId = session?.id ?? null;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    const current = sessionRef.current;
    setActivePath(current ? defaultFilePath(current.design) : null);
  }, [sessionId]);

  const running = rtlJob?.status === 'running';
  const aiConfigured = systemStatus ? Boolean(systemStatus.ai?.configured) : null;
  const linkedProject = linked && projects.some((p) => p.id === linked.id) ? linked : null;

  const explainJob = useJob(explainJobs, session && activePath ? explainKey(session.id, activePath) : null);
  const diagnostics = useMemo(() => (session ? designDiagnostics(session.design.compile, session.design.lint) : []), [session]);
  const savedProject = session?.saved ? (projects.find((p) => p.id === session.saved?.projectId) ?? null) : null;
  const tbRunning = tbJob?.status === 'running';

  /* ---------------------------------------------------------------- actions */

  const generate = () => {
    const text = spec.trim();
    if (!text || rtlJobs.isRunning(RTL_JOB)) return;
    const linkedProjectId = linkedProject?.id ?? null;
    // Same normalization as the language select shows (a stale localStorage value is not sent).
    const lang: HdlLanguage = language === 'systemverilog' ? 'systemverilog' : 'verilog';
    void rtlJobs
      .start(RTL_JOB, async (signal) => {
        const response = await api.ai.generateRtl({ spec: text, language: lang, project_id: linkedProjectId ?? undefined }, { signal });
        const next: GeneratorSession = {
          id: newSessionId(),
          spec: text,
          language: lang,
          linkedProjectId,
          createdAt: new Date().toISOString(),
          design: normalizeDesign(response),
          saved: null,
        };
        generatorSession.set(next);
        return next;
      })
      .then((outcome) => {
        if (outcome.ok) {
          const d = outcome.result.design;
          const compiled = d.compile ? (d.compile.ok ? 'compiles' : 'does not compile') : 'has no compile result';
          toast.success('Design generated', `${pluralize(d.rtl.files.length, 'RTL file')}; the RTL ${compiled}.`);
          if (mountedRef.current) setTab('architecture');
        } else if (!outcome.aborted && !mountedRef.current) {
          toast.error('RTL generation failed', outcome.error);
        }
      });
  };

  const explain = (path?: string, force = false) => {
    const s = sessionRef.current;
    if (!s) return;
    const target = path ?? activePath ?? defaultFilePath(s.design);
    const file = s.design.rtl.files.find((f) => f.path === target);
    if (!file) return;
    setTab('rtl');
    setActivePath(file.path);
    const key = explainKey(s.id, file.path);
    const existing = explainJobs.get(key);
    if (existing?.status === 'running' || (existing?.status === 'done' && !force)) return;
    void explainJobs
      .start(key, (signal) => api.ai.explain({ code: file.content, path: file.path, mode: 'line_by_line' }, { signal }))
      .then((outcome) => {
        if (!outcome.ok && !outcome.aborted && !mountedRef.current) toast.error(`Explanation of ${file.path} failed`, outcome.error);
      });
  };

  const startTestbench = (target: { id: number; name: string; simulator: Simulator }) => {
    const s = sessionRef.current;
    if (!s || testbenchJobs.isRunning(s.id)) return;
    void testbenchJobs
      .start(s.id, async (signal) => {
        const response = await api.ai.generateTestbench(
          { project_id: target.id, spec: s.spec, dut_module: s.design.rtl.top_module || undefined, simulator: target.simulator, save: true },
          { signal },
        );
        return { sessionId: s.id, projectId: target.id, projectName: target.name, simulator: target.simulator, response };
      })
      .then((outcome) => {
        if (!outcome.ok) {
          if (!outcome.aborted && !mountedRef.current) toast.error('Testbench generation failed', outcome.error);
          return;
        }
        const { response } = outcome.result;
        const tbPath = response.saved_file?.path ?? response.testbench?.path ?? 'The testbench';
        const repairs = repairCountOf(response.repair_iterations);
        const repairText = repairs > 0 ? ` after ${pluralize(repairs, 'repair iteration')}` : '';
        const note = saveNoteOf(response);
        if (!response.saved_file) {
          // Nothing was written (e.g. it does not compile): stay here and show the details.
          toast.warning(
            response.compile?.ok ? 'Testbench generated but not saved' : 'Testbench does not compile, so it was not saved',
            note ?? `${tbPath} was not written into ${target.name}.`,
          );
          return;
        }
        toast.success('Testbench generated', `${tbPath} compiles with ${simulatorLabel(target.simulator)}${repairText} and was saved to ${target.name}.`);
        if (projectIdRef.current === target.id) void refresh();
        if (mountedRef.current) {
          if (projectIdRef.current !== target.id) setProjectId(target.id);
          navigate('/verification');
        }
      });
  };

  const onGenerateTestbench = () => {
    if (!session) return;
    if (savedProject) startTestbench({ id: savedProject.id, name: savedProject.name, simulator: toSimulator(savedProject.simulator) });
    else setModal('testbench');
  };

  const onSaved = (intent: SaveIntent, outcome: SaveOutcome) => {
    const s = sessionRef.current;
    if (!s) return;
    generatorSession.update(s.id, (current) => ({
      ...current,
      saved: { projectId: outcome.detail.id, projectName: outcome.detail.name, at: new Date().toISOString() },
    }));
    setModal(null);
    openProject(outcome.detail);
    void refreshProjects();
    if (intent === 'create') {
      toast.success('Project created', outcome.message);
      navigate('/studio');
    } else if (intent === 'add') {
      toast.success('Design added to the project', outcome.message);
    } else {
      toast.info('Design saved', outcome.message);
      startTestbench({ id: outcome.detail.id, name: outcome.detail.name, simulator: toSimulator(outcome.detail.simulator) });
    }
  };

  const clearResult = () => {
    if (session) testbenchJobs.clear(session.id);
    generatorSession.set(null);
  };

  /* ---------------------------------------------------------------- render */

  const lintCounts = session?.design.lint ? countDiagnostics(session.design.lint.diagnostics) : null;
  const compileIssues = lintCounts ? lintCounts.errors + lintCounts.warnings : 0;

  return (
    <PageContainer>
      <PageHeader
        icon={<Sparkles />}
        title="AI Generator"
        description="Turn a natural-language specification into an architecture definition and synthesizable RTL. Claude writes the design; the backend compiles and lints it with the real tools."
      />

      {aiConfigured === false && (
        <div role="note" className="mb-4 flex items-start gap-3 rounded-xl border border-warn/35 bg-warn/[0.06] px-4 py-3">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1 text-[13px] leading-5 text-[#efd9a8]">
            <p className="font-semibold text-[#fde68a]">Claude API credentials are not configured on the backend</p>
            <p className="mt-0.5">
              Generation and explanation requests return HTTP 503 until <span className="font-mono">ANTHROPIC_API_KEY</span> is set
              in <span className="font-mono">backend/.env</span> and the backend is restarted.
            </p>
          </div>
          <Link to="/settings" className="shrink-0 text-xs font-medium text-accent hover:underline">
            Settings
          </Link>
        </div>
      )}

      <SpecForm
        spec={spec}
        onSpecChange={setSpec}
        onPickExample={(text) => {
          setSpec(text);
          setLinked(null);
        }}
        language={language === 'systemverilog' ? 'systemverilog' : 'verilog'}
        onLanguageChange={setLanguage}
        onGenerate={generate}
        running={running}
        project={project ? { id: project.id, name: project.name, spec: project.spec } : null}
        linkedProject={linkedProject}
        onUseProjectSpec={() => {
          if (!project) return;
          setSpec(project.spec);
          setLinked({ id: project.id, name: project.name });
        }}
        onUnlink={() => setLinked(null)}
      />

      {rtlJob?.status === 'running' && (
        <AIJobProgress
          className="mt-4"
          title="Generating the design with Claude"
          startedAt={rtlJob.startedAt}
          steps={RTL_STEPS}
          onCancel={() => rtlJobs.cancel(RTL_JOB)}
          note={
            <>
              The stages run on the server in one request (several minutes is normal). You can leave this page: the request keeps
              running and the result appears here when it arrives.
              {session ? ' The previous result stays visible until then.' : ''}
            </>
          }
        />
      )}
      {rtlJob?.status === 'error' && (
        <ErrorBanner
          className="mt-4"
          error={rtlJob.error}
          title="RTL generation failed"
          onRetry={generate}
          retryLabel="Try again"
          onDismiss={() => rtlJobs.clear(RTL_JOB)}
        />
      )}

      {!session ? (
        rtlJob?.status !== 'running' && (
          <div className="mt-4">
            <EmptyState
              icon={<Sparkles />}
              title="No design generated yet"
              description="Pick an example or describe your own block, then press Generate design. The latest result stays on this page (stored in this browser) until you generate a new one or clear it."
              action={
                <ol className="flex flex-wrap items-center justify-center gap-1.5">
                  {PIPELINE.map((stage, index) => {
                    const Icon = stage.icon;
                    return (
                      <li key={stage.label} className="flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs text-muted">
                          <Icon aria-hidden="true" className="size-3.5 text-accent/80" />
                          {stage.label}
                        </span>
                        {index < PIPELINE.length - 1 && <ChevronRight aria-hidden="true" className="size-3.5 text-border-strong" />}
                      </li>
                    );
                  })}
                </ol>
              }
            />
          </div>
        )
      ) : (
        <div className="mt-4 grid gap-4">
          <ResultHeader
            session={session}
            onExplain={() => explain()}
            explainBusy={explainJob?.status === 'running'}
            onCreateProject={() => setModal('create')}
            onAddToProject={() => setModal('add')}
            addDisabledReason={project ? null : 'Select a project in the top bar first'}
            onGenerateTestbench={onGenerateTestbench}
            testbenchBusy={tbRunning}
            testbenchTitle={
              savedProject
                ? `Generate a testbench in project “${savedProject.name}” and open Verification`
                : 'Save the design to a project, generate a testbench there and open Verification'
            }
            onOpenSavedProject={
              savedProject
                ? () => {
                    setProjectId(savedProject.id);
                    navigate('/studio');
                  }
                : null
            }
            onClear={clearResult}
            notPersisted={generatorSession.notPersisted}
          />

          <WorkflowNotes notes={session.design.notes} />
          {tbJob?.status === 'running' && (
            <AIJobProgress
              title={`Generating a testbench for ${session.design.rtl.top_module || 'the design'}`}
              startedAt={tbJob.startedAt}
              steps={testbenchSteps(toSimulator(savedProject?.simulator ?? project?.simulator))}
              onCancel={() => testbenchJobs.cancel(session.id)}
              note="When it is done the Verification page opens with the project selected, ready to simulate."
            />
          )}
          {tbJob?.status === 'error' && (
            <ErrorBanner
              error={tbJob.error}
              title="Testbench generation failed"
              onRetry={onGenerateTestbench}
              retryLabel="Try again"
              onDismiss={() => testbenchJobs.clear(session.id)}
            />
          )}
          {tbJob?.status === 'done' && tbJob.result && (
            <TestbenchResultPanel
              result={tbJob.result}
              regenerating={tbRunning}
              onRegenerate={() => {
                const r = tbJob.result;
                if (r) startTestbench({ id: r.projectId, name: r.projectName, simulator: r.simulator });
              }}
              onOpenVerification={() => {
                const pid = tbJob.result?.projectId;
                if (pid !== undefined && pid !== projectIdRef.current) setProjectId(pid);
                navigate('/verification');
              }}
            />
          )}

          <Tabs<ResultTab>
            aria-label="Generated design"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'architecture', label: 'Architecture', icon: <Layers aria-hidden="true" /> },
              {
                id: 'rtl',
                label: 'RTL files',
                icon: <FileCode aria-hidden="true" />,
                badge: formatNumber(session.design.rtl.files.length),
              },
              {
                id: 'compile',
                label: 'Compile & lint',
                icon: <Hammer aria-hidden="true" />,
                badge: session.design.compile && !session.design.compile.ok ? '!' : compileIssues > 0 ? formatNumber(compileIssues) : undefined,
              },
              { id: 'explanation', label: 'Explanation', icon: <BookOpen aria-hidden="true" /> },
              {
                id: 'tests',
                label: 'Test plan',
                icon: <ListChecks aria-hidden="true" />,
                badge: formatNumber(session.design.rtl.test_cases.length),
              },
            ]}
          />

          {tab === 'architecture' && <ArchitecturePanel architecture={session.design.architecture} />}
          {tab === 'rtl' && (
            <RtlFilesPanel
              sessionId={session.id}
              files={session.design.rtl.files}
              diagnostics={diagnostics}
              activePath={activePath}
              onActivePathChange={setActivePath}
              onExplain={(path) => explain(path, true)}
            />
          )}
          {tab === 'compile' && (
            <CompilePanel
              compile={session.design.compile}
              lint={session.design.lint}
              repairCount={session.design.repairCount}
              repairs={session.design.repairs}
            />

          )}
          {tab === 'explanation' && <ExplanationPanel rtl={session.design.rtl} />}
          {tab === 'tests' && (
            <TestPlanPanel rtl={session.design.rtl} onGenerateTestbench={onGenerateTestbench} testbenchBusy={tbRunning} />
          )}

          <p className="flex items-center gap-1.5 text-2xs text-subtle">
            <Badge size="xs" tone="neutral">
              AI
            </Badge>
            Architecture, RTL, explanation and test plan are written by Claude; compile and lint results come from the real tools.
            Review the design and verify it with a testbench before use.
          </p>
        </div>
      )}

      {session && modal !== null && (
        <SaveDesignModal
          open
          intent={modal}
          session={session}
          onClose={() => setModal(null)}
          onSaved={(outcome) => onSaved(modal, outcome)}
        />
      )}
    </PageContainer>
  );
}
