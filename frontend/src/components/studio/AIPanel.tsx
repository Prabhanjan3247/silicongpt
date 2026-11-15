import { memo } from 'react';
import { Sparkles } from 'lucide-react';
import type { Diagnostic, FileMeta, Hierarchy, ProjectDetail, RunDetail, RunSummary } from '../../services/types';
import { useProject } from '../../state/ProjectContext';
import { summarizeAI } from '../../lib/system';
import { Badge, Tabs, type TabItem } from '../ui';
import { AskTab } from './AskTab';
import { isDirty, type FileBuffer } from './buffers';
import { ExplainTab } from './ExplainTab';
import { FixesTab } from './FixesTab';
import { IssuesTab } from './IssuesTab';
import { SpecTab } from './SpecTab';
import type { RevealHandler, RevealPathHandler } from './types';

export type AITab = 'explain' | 'issues' | 'fixes' | 'spec' | 'ask';
export const AI_TABS: readonly AITab[] = ['explain', 'issues', 'fixes', 'spec', 'ask'];

export interface AIPanelProps {
  tab: AITab;
  onTabChange: (tab: AITab) => void;
  project: ProjectDetail;
  file: FileMeta | null;
  buffer: FileBuffer | null;
  diagnostics: readonly Diagnostic[];
  lastRun: RunSummary | RunDetail | null;
  hierarchy: Hierarchy | null;
  hierarchyLoading: boolean;
  hierarchyError: unknown;
  onReloadHierarchy: () => void;
  onProjectUpdated: (detail: ProjectDetail) => void;
  onReveal: RevealHandler;
  onRevealPath: RevealPathHandler;
  onSelectDiagnostic: (d: Diagnostic) => void;
}

/** Right-hand AI panel: Explain, Issues, Fixes, Spec and Ask. */
export const AIPanel = memo(function AIPanel({
  tab,
  onTabChange,
  project,
  file,
  buffer,
  diagnostics,
  lastRun,
  hierarchy,
  hierarchyLoading,
  hierarchyError,
  onReloadHierarchy,
  onProjectUpdated,
  onReveal,
  onRevealPath,
  onSelectDiagnostic,
}: AIPanelProps) {
  const { systemStatus, systemStatusError } = useProject();
  const ai = summarizeAI(systemStatus, systemStatusError);
  const fileIssues = file ? diagnostics.filter((d) => d.file && d.file.toLowerCase() === file.path.toLowerCase()).length : 0;

  const tabs: TabItem<AITab>[] = [
    { id: 'explain', label: 'Explain', title: 'AI explanation of the active file' },
    { id: 'issues', label: 'Issues', title: 'Tool diagnostics and AI-reported issues', badge: fileIssues > 0 ? fileIssues : undefined },
    { id: 'fixes', label: 'Fixes', title: 'Latest AI debugging session' },
    { id: 'spec', label: 'Spec', title: 'Project specification, modules and ports' },
    { id: 'ask', label: 'Ask', title: 'Ask the AI assistant about this project' },
  ];

  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel/50" aria-label="AI assistant">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <Sparkles className="size-3.5 text-accent" aria-hidden="true" />
        <span className="flex-1 truncate text-[10.5px] font-semibold uppercase tracking-wider text-subtle">AI assistant</span>
        <Badge
          tone={ai.level === 'ok' ? 'pass' : ai.level === 'down' ? 'warn' : 'neutral'}
          size="xs"
          dot
          title={ai.detail}
        >
          {ai.label}
        </Badge>
      </header>
      <Tabs<AITab>
        tabs={tabs}
        value={tab}
        onChange={onTabChange}
        size="sm"
        aria-label="AI panel"
        className="shrink-0 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {tab === 'explain' && <ExplainTab projectId={project.id} file={file} buffer={buffer} onReveal={onReveal} />}
        {tab === 'issues' && (
          <IssuesTab
            projectId={project.id}
            file={file}
            buffer={buffer}
            diagnostics={diagnostics}
            onSelectDiagnostic={onSelectDiagnostic}
            onReveal={onReveal}
            onOpenExplain={() => onTabChange('explain')}
          />
        )}
        {tab === 'fixes' && <FixesTab projectId={project.id} lastRun={lastRun} onRevealPath={onRevealPath} />}
        {tab === 'spec' && (
          <SpecTab
            project={project}
            hierarchy={hierarchy}
            hierarchyLoading={hierarchyLoading}
            hierarchyError={hierarchyError}
            onReloadHierarchy={onReloadHierarchy}
            onProjectUpdated={onProjectUpdated}
            onRevealPath={onRevealPath}
          />
        )}
        {tab === 'ask' && (
          <AskTab projectId={project.id} file={file} fileDirty={isDirty(buffer)} lastRun={lastRun} onRevealPath={onRevealPath} />
        )}
      </div>
    </aside>
  );
});
