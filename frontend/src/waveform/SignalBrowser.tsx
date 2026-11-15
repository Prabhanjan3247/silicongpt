/**
 * Signal browser: the VCD scope tree with a search filter. Clicking a signal adds it to the
 * viewer (or removes it when it is shown); scopes can add all of their own signals at once.
 */
import { memo, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, ChevronRight, Hash, ListPlus, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { WaveSignalInfo } from '../services/types';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { buildScopeTree, searchSignals, type ScopeNode } from './scopeTree';

export interface SignalBrowserProps {
  signals: readonly WaveSignalInfo[];
  /** Names currently shown in the viewer. */
  shown: ReadonlySet<string>;
  onAdd: (names: string[]) => void;
  onRemove: (name: string) => void;
  onResetDefault: () => void;
  onClear: () => void;
  /** Size of the default selection (0 = none could be computed). */
  defaultCount: number;
  /** Maximum number of signals in the viewer. */
  max: number;
  /** Scopes expanded initially (e.g. the testbench and DUT scopes). */
  initialExpanded: readonly string[];
}

const SEARCH_LIMIT = 250;
const PLAIN_TYPES = new Set(['wire', 'reg', 'logic', 'bit']);
/** Expansion key suffix of a scope's parameter group (cannot clash with a dotted scope path). */
const PARAM_GROUP_SUFFIX = '#parameters';

/** Icarus dumps `parameter`/`localparam` values as VCD variables of type "parameter". */
function splitParameters(list: readonly WaveSignalInfo[]): { plain: WaveSignalInfo[]; params: WaveSignalInfo[] } {
  const plain: WaveSignalInfo[] = [];
  const params: WaveSignalInfo[] = [];
  for (const s of list) (s.type.toLowerCase() === 'parameter' ? params : plain).push(s);
  return { plain, params };
}

function SignalItem({
  s,
  shown,
  depth,
  showScope,
  onToggle,
}: {
  s: WaveSignalInfo;
  shown: boolean;
  depth: number;
  showScope: boolean;
  onToggle: (s: WaveSignalInfo) => void;
}) {
  const type = s.type.toLowerCase();
  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(s)}
        aria-pressed={shown}
        title={`${s.full_name} · ${s.width} bit${s.width === 1 ? '' : 's'} · ${s.type}${shown ? ' (shown: click to remove)' : ' (click to add)'}`}
        className={clsx(
          'group flex h-6 w-full items-center gap-1.5 rounded-md pr-1.5 text-left font-mono text-[11.5px] hover:bg-raised',
          shown ? 'text-accent' : 'text-text',
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span
          className={clsx(
            'flex size-3.5 shrink-0 items-center justify-center rounded-sm [&_svg]:size-3',
            shown ? 'bg-accent/20 text-accent' : 'text-subtle group-hover:text-text',
          )}
          aria-hidden="true"
        >
          {shown ? <Check /> : <Plus />}
        </span>
        {showScope && s.scope && <span className="min-w-0 shrink truncate text-subtle">{s.scope}.</span>}
        <span className="truncate">{s.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-[10px] text-subtle">
          {!PLAIN_TYPES.has(type) && <span className="rounded bg-raised px-1 leading-4">{type}</span>}
          {s.width > 1 && <span>{s.width}b</span>}
        </span>
      </button>
    </li>
  );
}

function ScopeItem({
  node,
  depth,
  expanded,
  onToggleExpand,
  shown,
  onToggleSignal,
  onAddScope,
}: {
  node: ScopeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggleExpand: (path: string) => void;
  shown: ReadonlySet<string>;
  onToggleSignal: (s: WaveSignalInfo) => void;
  onAddScope: (node: ScopeNode) => void;
}) {
  const open = expanded.has(node.path);
  const { plain, params } = splitParameters(node.signals);
  const own = plain.length;
  const paramKey = `${node.path}${PARAM_GROUP_SUFFIX}`;
  const paramsOpen = expanded.has(paramKey);
  const shownHere = node.signals.reduce((n, s) => n + (shown.has(s.full_name) ? 1 : 0), 0);
  return (
    <li>
      <div className="group flex h-6 items-center rounded-md pr-1 hover:bg-raised" style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          onClick={() => onToggleExpand(node.path)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-[#c3cede]"
          title={`${node.path} · ${node.total} signal${node.total === 1 ? '' : 's'}`}
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />
          )}
          <span className="truncate font-mono font-medium">{node.name}</span>
          <span className="shrink-0 text-[10px] text-subtle">
            {shownHere > 0 ? `${shownHere}/` : ''}
            {node.total}
          </span>
        </button>
        {own > 0 && (
          <button
            type="button"
            onClick={() => onAddScope(node)}
            className="ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-subtle opacity-0 hover:bg-hover hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={`Add the ${own} signals of scope ${node.path}`}
            title={`Add the ${own} signal${own === 1 ? '' : 's'} declared in ${node.path}${params.length > 0 ? ' (parameters not included)' : ''}`}
          >
            <ListPlus className="size-3.5" />
          </button>
        )}
      </div>
      {open && (
        <ul>
          {node.children.map((c) => (
            <ScopeItem
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              shown={shown}
              onToggleSignal={onToggleSignal}
              onAddScope={onAddScope}
            />
          ))}
          {plain.map((s) => (
            <SignalItem
              key={s.full_name}
              s={s}
              shown={shown.has(s.full_name)}
              depth={depth + 1}
              showScope={false}
              onToggle={onToggleSignal}
            />
          ))}
          {params.length > 0 && (
            <li>
              <button
                type="button"
                onClick={() => onToggleExpand(paramKey)}
                aria-expanded={paramsOpen}
                className="flex h-6 w-full items-center gap-1 rounded-md pr-1.5 text-left text-[11px] text-subtle hover:bg-raised hover:text-muted"
                style={{ paddingLeft: (depth + 1) * 12 }}
                title={`Parameters of ${node.path} (constants dumped by the simulator; never part of the default selection)`}
              >
                {paramsOpen ? (
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                )}
                <Hash aria-hidden="true" className="size-3 shrink-0" />
                <span className="font-medium">parameters</span>
                <span className="text-[10px]">{params.length}</span>
              </button>
              {paramsOpen && (
                <ul>
                  {params.map((s) => (
                    <SignalItem
                      key={s.full_name}
                      s={s}
                      shown={shown.has(s.full_name)}
                      depth={depth + 2}
                      showScope={false}
                      onToggle={onToggleSignal}
                    />
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export const SignalBrowser = memo(function SignalBrowser({
  signals,
  shown,
  onAdd,
  onRemove,
  onResetDefault,
  onClear,
  defaultCount,
  max,
  initialExpanded,
}: SignalBrowserProps) {
  const tree = useMemo(() => buildScopeTree(signals), [signals]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const p of initialExpanded) {
      // expand the path and its parents
      let cur = p;
      while (cur) {
        set.add(cur);
        const i = cur.lastIndexOf('.');
        cur = i > 0 ? cur.slice(0, i) : '';
      }
    }
    if (set.size === 0 && tree.children.length === 1) set.add(tree.children[0].path);
    return set;
  });
  const search = useMemo(
    () => (query.trim() ? searchSignals(signals, query, SEARCH_LIMIT) : null),
    [signals, query],
  );

  const toggleExpand = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleSignal = (s: WaveSignalInfo) => {
    if (shown.has(s.full_name)) onRemove(s.full_name);
    else onAdd([s.full_name]);
  };
  const addScope = (node: ScopeNode) => onAdd(splitParameters(node.signals).plain.map((s) => s.full_name));
  const room = Math.max(0, max - shown.size);
  const addableMatches = search ? search.matches.filter((s) => !shown.has(s.full_name)) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-border p-2.5">
        <Input
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter signals (e.g. dut  or  *_valid)"
          aria-label="Filter signals by name"
          leftIcon={<Search />}
          mono
          rightSlot={
            query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="inline-flex size-5 items-center justify-center rounded text-subtle hover:bg-hover hover:text-text"
                aria-label="Clear filter"
              >
                <X className="size-3.5" />
              </button>
            ) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="secondary"
            icon={<RotateCcw />}
            onClick={onResetDefault}
            disabled={defaultCount === 0}
            title="DUT ports first, then testbench top-level signals (constants, integer counters and loop variables are skipped)"
          >
            Default ({defaultCount})
          </Button>
          <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={onClear} disabled={shown.size === 0}>
            Clear
          </Button>
          <span className="ml-auto text-2xs text-subtle">
            {shown.size}/{max} shown · {signals.length} in VCD
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {search ? (
          <>
            <div className="flex items-center gap-2 px-1.5 pb-1.5 pt-0.5 text-2xs text-subtle">
              <span>
                {search.total === 0
                  ? 'No signal matches the filter.'
                  : `${search.total} match${search.total === 1 ? '' : 'es'}${search.total > search.matches.length ? `, first ${search.matches.length} listed` : ''}`}
              </span>
              {addableMatches.length > 0 && room > 0 && (
                <button
                  type="button"
                  onClick={() => onAdd(addableMatches.slice(0, room).map((s) => s.full_name))}
                  className="ml-auto rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
                >
                  Add {Math.min(room, addableMatches.length)}
                </button>
              )}
            </div>
            <ul>
              {search.matches.map((s) => (
                <SignalItem
                  key={s.full_name}
                  s={s}
                  shown={shown.has(s.full_name)}
                  depth={0}
                  showScope
                  onToggle={toggleSignal}
                />
              ))}
            </ul>
          </>
        ) : (
          <ul>
            {tree.children.map((c) => (
              <ScopeItem
                key={c.path}
                node={c}
                depth={0}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                shown={shown}
                onToggleSignal={toggleSignal}
                onAddScope={addScope}
              />
            ))}
            {tree.signals.map((s) => (
              <SignalItem
                key={s.full_name}
                s={s}
                shown={shown.has(s.full_name)}
                depth={0}
                showScope={false}
                onToggle={toggleSignal}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
