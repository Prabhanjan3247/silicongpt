/**
 * Reports (/reports) - fe-verify.
 *
 * Builds the verification report of the selected project (GET /api/projects/{pid}/report
 * ?format=json, assembled by the backend from recorded rows only) and renders it as a
 * structured page: verification statement, latest run, coverage, run history, AI debug
 * sessions, patches, synthesis, AI usage, environment and limitations. Markdown / HTML / JSON
 * downloads and the standalone HTML report come straight from the backend renderers.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, FolderOpen, RefreshCw } from 'lucide-react';
import { api, isAbortError } from '../services/api';
import type { ReportFormat, VerificationReport } from '../services/types';
import { useProject } from '../state/ProjectContext';
import { formatDateTime } from '../lib/format';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Button, ButtonLink, buttonClasses } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { LoadingState } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { REPORT_SECTIONS, ReportView } from '../components/reports/ReportView';

interface ReportState {
  pid: number | null;
  report: VerificationReport | null;
  loading: boolean;
  error: unknown;
}

const FORMAT_LABEL: Record<ReportFormat, string> = { markdown: 'Markdown', html: 'HTML', json: 'JSON' };

export default function ReportsPage() {
  const { projectId, project } = useProject();
  const toast = useToast();
  const [state, setState] = useState<ReportState>({ pid: null, report: null, loading: projectId !== null, error: null });
  const [nonce, setNonce] = useState(0);
  const [downloading, setDownloading] = useState<ReportFormat | null>(null);

  useEffect(() => {
    if (projectId === null) {
      setState({ pid: null, report: null, loading: false, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState((s) => ({ pid: projectId, report: s.pid === projectId ? s.report : null, loading: true, error: null }));
    api.reports.json(projectId, { signal: controller.signal }).then(
      (report) => setState({ pid: projectId, report, loading: false, error: null }),
      (err: unknown) => {
        if (!isAbortError(err)) setState((s) => ({ ...s, pid: projectId, loading: false, error: err }));
      },
    );
    return () => controller.abort();
  }, [projectId, nonce]);

  const rebuild = useCallback(() => setNonce((n) => n + 1), []);

  const download = async (format: ReportFormat) => {
    if (projectId === null) return;
    setDownloading(format);
    try {
      const name = await api.reports.download(projectId, format);
      toast.success(`${FORMAT_LABEL[format]} report downloaded`, name);
    } catch (err) {
      toast.error(`Could not download the ${FORMAT_LABEL[format]} report`, err);
    } finally {
      setDownloading(null);
    }
  };

  const current = state.pid === projectId ? state : { ...state, report: null };
  const report = current.report;

  const header = (
    <PageHeader
      icon={<FileText />}
      eyebrow={project?.name}
      title="Verification report"
      description="Built by the backend from recorded simulation runs, AI sessions, file revisions and synthesis results only. Missing evidence is reported as missing, never estimated."
      actions={
        projectId !== null ? (
          <>
            <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={current.loading} onClick={rebuild}>
              Rebuild
            </Button>
            <Button size="sm" variant="secondary" icon={<Download />} loading={downloading === 'markdown'} disabled={downloading !== null} onClick={() => void download('markdown')}>
              Markdown
            </Button>
            <Button size="sm" variant="secondary" icon={<Download />} loading={downloading === 'html'} disabled={downloading !== null} onClick={() => void download('html')}>
              HTML
            </Button>
            <Button size="sm" variant="ghost" icon={<Download />} loading={downloading === 'json'} disabled={downloading !== null} onClick={() => void download('json')}>
              JSON
            </Button>
            <a
              href={api.reports.url(projectId, 'html')}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              title="Open the standalone HTML report in a new tab"
            >
              <ExternalLink />
              Open HTML
            </a>
          </>
        ) : undefined
      }
    />
  );

  if (projectId === null) {
    return (
      <PageContainer>
        {header}
        <EmptyState
          icon={<FolderOpen />}
          title="No project selected"
          description="Select a project in the top bar to build its verification report."
          action={
            <ButtonLink to="/projects" variant="primary" icon={<FolderOpen />}>
              Open projects
            </ButtonLink>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      {current.error ? (
        <ErrorBanner error={current.error} title="Could not build the report" onRetry={rebuild} retrying={current.loading} className="mb-4" />
      ) : null}
      {!report ? (
        current.loading ? <LoadingState label="Building the report…" minHeight="40vh" /> : null
      ) : (
        <div className="grid gap-5 xl:grid-cols-[13rem_minmax(0,1fr)]">
          <nav aria-label="Report sections" className="hidden xl:block">
            <div className="sticky top-4 flex flex-col gap-0.5 rounded-xl border border-border bg-panel/70 p-2">
              <p className="px-2 pb-1 pt-0.5 text-2xs font-medium uppercase tracking-wider text-subtle">Sections</p>
              {REPORT_SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-raised hover:text-text"
                >
                  {s.label}
                </button>
              ))}
              <p className="mt-1 border-t border-border px-2 pt-2 text-2xs leading-4 text-subtle">
                Built {formatDateTime(report.generated_at)}
                {current.loading ? ' · rebuilding…' : ''}
              </p>
            </div>
          </nav>
          <div className={current.loading ? 'opacity-70 transition-opacity' : undefined}>
            <ReportView report={report} />
          </div>
        </div>
      )}
    </PageContainer>
  );
}
