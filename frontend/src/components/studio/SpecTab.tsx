import { useMemo, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Boxes, FileText, ListTree, RefreshCw, Save, Undo2 } from 'lucide-react';
import { api } from '../../services/api';
import type { Hierarchy, ModuleInfo, ProjectDetail } from '../../services/types';
import { formatNumber } from '../../lib/format';
import { Badge, Button, EmptyState, ErrorBanner, LoadingState, TextArea, useToast } from '../ui';
import { useSessionState } from './sessionStore';
import type { RevealPathHandler } from './types';

const NO_DRAFT: string | null = null;

export interface SpecTabProps {
  project: ProjectDetail;
  hierarchy: Hierarchy | null;
  hierarchyLoading: boolean;
  hierarchyError: unknown;
  onReloadHierarchy: () => void;
  onProjectUpdated: (detail: ProjectDetail) => void;
  onRevealPath: RevealPathHandler;
}

/** Editable natural-language spec of the project + modules / ports parsed from the sources. */
export function SpecTab({
  project,
  hierarchy,
  hierarchyLoading,
  hierarchyError,
  onReloadHierarchy,
  onProjectUpdated,
  onRevealPath,
}: SpecTabProps) {
  const toast = useToast();
  const [draft, setDraft] = useSessionState<string | null>(`studio.specDraft.${project.id}`, NO_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const value = draft ?? project.spec;
  const dirty = draft !== null && draft !== project.spec;

  const save = async () => {
    if (!dirty || saving || draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const detail = await api.projects.update(project.id, { spec: draft });
      onProjectUpdated(detail);
      setDraft(null);
      toast.success('Specification saved');
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      void save();
    }
  };

  const modules = hierarchy?.modules ?? [];
  const top = project.top_module || hierarchy?.suggested_top || null;
  const tb = project.tb_top || hierarchy?.suggested_tb_top || null;
  const ordered = useMemo(() => {
    const rank = (m: ModuleInfo) => (m.name === top ? 0 : m.is_testbench ? (m.name === tb ? 2 : 3) : 1);
    return [...modules].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [modules, top, tb]);
  const byName = useMemo(() => new Map(modules.map((m) => [m.name, m])), [modules]);
  const root = (tb && byName.get(tb)) || (top && byName.get(top)) || null;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <FileText className="size-3.5 text-subtle" aria-hidden="true" />
          <h4 className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Specification</h4>
          {dirty && (
            <Badge tone="warn" size="xs">
              unsaved
            </Badge>
          )}
        </div>
        <TextArea
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={8}
          placeholder="Describe the intended behaviour: ports, timing, reset, corner cases. The AI agents (generator, testbench, debugger) read this text."
          aria-label="Project specification"
          className="text-xs"
        />
        <div className="flex items-center gap-2">
          <span className="flex-1 text-2xs text-subtle">{formatNumber(value.length)} characters · Ctrl+S saves</span>
          <Button size="xs" variant="ghost" icon={<Undo2 />} disabled={!dirty || saving} onClick={() => setDraft(null)}>
            Discard
          </Button>
          <Button size="xs" variant="primary" icon={<Save />} disabled={!dirty} loading={saving} onClick={() => void save()}>
            Save spec
          </Button>
        </div>
        {saveError ? <ErrorBanner error={saveError} title="Could not save the specification" /> : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Boxes className="size-3.5 text-subtle" aria-hidden="true" />
          <h4 className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
            Modules{hierarchy ? ` (${modules.length})` : ''}
          </h4>
          <Button
            size="xs"
            variant="ghost"
            iconOnly
            icon={<RefreshCw />}
            aria-label="Re-analyze the sources"
            title="Re-analyze the sources"
            loading={hierarchyLoading}
            onClick={onReloadHierarchy}
          />
        </div>
        {hierarchyError ? (
          <ErrorBanner error={hierarchyError} title="Could not analyze the module hierarchy" onRetry={onReloadHierarchy} />
        ) : !hierarchy ? (
          <LoadingState label="Analyzing the sources…" minHeight="6rem" />
        ) : modules.length === 0 ? (
          <EmptyState compact icon={<Boxes />} title="No modules found" description="The parser found no module declarations in the project's sources." />
        ) : (
          <>
            {root && (
              <div className="rounded-lg border border-border bg-surface/60 px-2.5 py-2">
                <p className="mb-1 flex items-center gap-1.5 text-2xs font-medium text-muted">
                  <ListTree className="size-3.5" aria-hidden="true" /> Hierarchy
                </p>
                <HierarchyNode module={root} byName={byName} depth={0} trail={[]} onRevealPath={onRevealPath} />
              </div>
            )}
            {ordered.map((m) => (
              <ModuleCard
                key={`${m.file}:${m.name}`}
                module={m}
                isTop={m.name === top}
                isTb={m.name === tb}
                defaultOpen={m.name === top || modules.length <= 2}
                onRevealPath={onRevealPath}
              />
            ))}
            <p className="text-2xs leading-4 text-subtle">Parsed from the saved sources by the backend RTL parser.</p>
          </>
        )}
      </section>
    </div>
  );
}

function HierarchyNode({
  module,
  byName,
  depth,
  trail,
  instance,
  onRevealPath,
}: {
  module: ModuleInfo;
  byName: Map<string, ModuleInfo>;
  depth: number;
  trail: string[];
  instance?: string;
  onRevealPath: RevealPathHandler;
}) {
  const children = depth < 8 && !trail.includes(module.name) ? module.instances : [];
  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 12 }} className={clsx(depth > 0 && 'border-l border-border/70')}>
      <button
        type="button"
        onClick={() => onRevealPath({ path: module.file, line: module.line, endLine: module.end_line, tone: 'focus' })}
        className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-2xs hover:bg-hover/60"
        title={`${module.file}:${module.line}`}
      >
        {instance && <span className="text-subtle">{instance}:</span>}
        <span className={module.is_testbench ? 'text-[#c4b5fd]' : 'text-accent'}>{module.name}</span>
      </button>
      {children.map((inst) => {
        const child = byName.get(inst.module);
        return child ? (
          <HierarchyNode
            key={`${inst.instance}-${inst.line}`}
            module={child}
            byName={byName}
            depth={depth + 1}
            trail={[...trail, module.name]}
            instance={inst.instance}
            onRevealPath={onRevealPath}
          />
        ) : (
          <div key={`${inst.instance}-${inst.line}`} style={{ paddingLeft: 12 }} className="border-l border-border/70">
            <span className="px-1 font-mono text-2xs text-subtle" title="Module not found in the project sources">
              {inst.instance}: {inst.module} (external)
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ModuleCard({
  module: m,
  isTop,
  isTb,
  defaultOpen,
  onRevealPath,
}: {
  module: ModuleInfo;
  isTop: boolean;
  isTb: boolean;
  defaultOpen: boolean;
  onRevealPath: RevealPathHandler;
}) {
  return (
    <details open={defaultOpen} className="group rounded-lg border border-border bg-surface/60">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate font-mono text-xs font-medium text-text">{m.name}</span>
        {isTop && (
          <Badge tone="accent" size="xs">
            top
          </Badge>
        )}
        {isTb && (
          <Badge tone="violet" size="xs">
            tb top
          </Badge>
        )}
        <Badge tone={m.is_testbench ? 'violet' : m.is_sequential ? 'blue' : 'neutral'} size="xs">
          {m.is_testbench ? 'testbench' : m.is_sequential ? 'sequential' : 'combinational'}
        </Badge>
        <span className="flex-1" />
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onRevealPath({ path: m.file, line: m.line, endLine: m.end_line, tone: 'focus' });
          }}
          className="shrink-0 font-mono text-2xs text-muted underline decoration-border-strong underline-offset-2 hover:text-accent"
          title="Show the module in the editor"
        >
          {m.file}:{m.line}
        </button>
      </summary>
      <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
        {(m.clocks.length > 0 || m.resets.length > 0) && (
          <div className="flex flex-wrap gap-1.5 text-2xs">
            {m.clocks.map((c) => (
              <Badge key={`clk-${c}`} tone="neutral" size="xs" mono>
                clock {c}
              </Badge>
            ))}
            {m.resets.map((r) => (
              <Badge key={`rst-${r.name}`} tone="neutral" size="xs" mono>
                reset {r.name} ({r.active_low ? 'active low' : 'active high'})
              </Badge>
            ))}
          </div>
        )}
        {m.ports.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse text-left text-2xs">
              <thead className="bg-raised text-subtle">
                <tr>
                  <th className="px-2 py-1 font-medium">Dir</th>
                  <th className="px-2 py-1 font-medium">Port</th>
                  <th className="px-2 py-1 text-right font-medium">Bits</th>
                  <th className="px-2 py-1 font-medium">Range / type</th>
                </tr>
              </thead>
              <tbody>
                {m.ports.map((p) => (
                  <tr
                    key={`${p.name}-${p.line}`}
                    className="cursor-pointer border-t border-border/70 hover:bg-hover/60"
                    onClick={() => onRevealPath({ path: m.file, line: p.line, tone: 'focus' })}
                    title={`${m.file}:${p.line}`}
                  >
                    <td
                      className={clsx(
                        'whitespace-nowrap px-2 py-1 font-mono',
                        p.direction === 'input' ? 'text-[#93c5fd]' : p.direction === 'output' ? 'text-[#86efac]' : 'text-[#fbbf24]',
                      )}
                    >
                      {p.direction}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-text">{p.name}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums text-muted">
                      {p.width ?? (p.width_expr ? '?' : 1)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-subtle">
                      {[p.signed ? 'signed' : null, p.type, p.width_expr ? `[${p.width_expr}]` : null].filter(Boolean).join(' ') || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-2xs text-subtle">No ports.</p>
        )}
        {m.params.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {m.params.map((p) => (
              <Badge key={p.name} tone="neutral" size="xs" mono title={p.local ? 'localparam' : 'parameter'}>
                {p.local ? 'localparam ' : ''}
                {p.name}
                {p.value !== null ? ` = ${p.value}` : ''}
              </Badge>
            ))}
          </div>
        )}
        {m.instances.length > 0 && (
          <p className="text-2xs text-muted">
            Instantiates:{' '}
            {m.instances.map((inst, i) => (
              <span key={`${inst.instance}-${inst.line}`} className="font-mono">
                {i > 0 ? ', ' : ''}
                {inst.instance} ({inst.module})
              </span>
            ))}
          </p>
        )}
      </div>
    </details>
  );
}
