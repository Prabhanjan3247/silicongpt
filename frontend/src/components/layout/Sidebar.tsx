import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import { Cpu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { NAV_GROUP_LABELS, NAV_ROUTES, type NavRoute } from '../../routes';
import { useProject } from '../../state/ProjectContext';

export interface SidebarProps {
  /** Desktop icon-rail mode. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Mobile drawer visibility. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={clsx('flex h-13 shrink-0 items-center gap-2.5 border-b border-border', collapsed ? 'justify-center px-2' : 'px-4')}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-accent/25 to-blue/30 ring-1 ring-inset ring-accent/35 shadow-glow">
        <Cpu className="size-4 text-accent" aria-hidden="true" />
      </span>
      {!collapsed && (
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight text-text">
            Silicon<span className="text-accent">GPT</span>
          </p>
          <p className="truncate text-[10.5px] text-subtle">RTL design · verification · debug</p>
        </div>
      )}
    </div>
  );
}

function NavItem({ route, collapsed, onNavigate }: { route: NavRoute; collapsed: boolean; onNavigate?: () => void }) {
  const Icon = route.icon;
  return (
    <NavLink
      to={route.path}
      end={route.path === '/'}
      onClick={onNavigate}
      title={collapsed ? `${route.label} - ${route.hint}` : route.hint}
      aria-label={collapsed ? route.label : undefined}
      className={({ isActive }) =>
        clsx(
          'group relative flex h-9 items-center gap-3 rounded-lg text-[13px] font-medium transition-colors',
          collapsed ? 'justify-center px-0' : 'px-3',
          isActive ? 'bg-accent/10 text-text' : 'text-muted hover:bg-raised hover:text-text',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
          <Icon
            aria-hidden="true"
            className={clsx('size-4 shrink-0', isActive ? 'text-accent' : 'text-subtle group-hover:text-muted')}
          />
          {!collapsed && <span className="truncate">{route.label}</span>}
        </>
      )}
    </NavLink>
  );
}

function SidebarBody({
  collapsed,
  onNavigate,
  footer,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  footer: ReactNode;
}) {
  const main = NAV_ROUTES.filter((r) => r.group !== 'system');
  const system = NAV_ROUTES.filter((r) => r.group === 'system');
  return (
    <>
      <Brand collapsed={collapsed} />
      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3">
        <div className="flex flex-col gap-0.5">
          {main.map((route, i) => {
            const groupStart = i === 0 || main[i - 1]?.group !== route.group;
            return (
              <Fragment key={route.path}>
                {groupStart &&
                  (collapsed ? (
                    i > 0 && <span aria-hidden="true" className="mx-3 my-2 h-px bg-border" />
                  ) : (
                    <p className={clsx('px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle', i > 0 && 'pt-3')}>
                      {NAV_GROUP_LABELS[route.group]}
                    </p>
                  ))}
                <NavItem route={route} collapsed={collapsed} onNavigate={onNavigate} />
              </Fragment>
            );
          })}
        </div>
        <div className="mt-auto flex flex-col gap-0.5 pt-4">
          {system.map((route) => (
            <NavItem key={route.path} route={route} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      </nav>
      <div className="shrink-0 border-t border-border px-2 py-2">{footer}</div>
    </>
  );
}

/** Collapsible primary navigation (desktop rail + mobile drawer), in contract order. */
export function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const { systemStatus, systemStatusError } = useProject();
  const version = systemStatus?.version;
  const versionText = systemStatusError ? 'Backend offline' : version ? `Backend v${version.replace(/^v/i, '')}` : '';
  const drawerRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onCloseMobile);
  onCloseRef.current = onCloseMobile;

  // Mobile drawer: focus the active (or first) link on open, Escape closes it, focus returns to
  // the element that opened it.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    (drawer?.querySelector<HTMLElement>('a[aria-current="page"]') ?? drawer?.querySelector<HTMLElement>('a[href]'))?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [mobileOpen]);

  return (
    <>
      <aside
        className={clsx(
          'hidden shrink-0 flex-col border-r border-border bg-surface/85 md:flex',
          collapsed ? 'w-[60px]' : 'w-60',
        )}
      >
        <SidebarBody
          collapsed={collapsed}
          footer={
            <div className={clsx('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between pl-2')}>
              {!collapsed && (
                <span className={clsx('truncate text-2xs', systemStatusError ? 'text-[#f87171]' : 'text-subtle')}>{versionText}</span>
              )}
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className="flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-raised hover:text-text"
              >
                {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
              </button>
            </div>
          }
        />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div aria-hidden="true" className="absolute inset-0 bg-[#02050c]/70" onClick={onCloseMobile} />
          <aside ref={drawerRef} className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-surface shadow-pop">
            <SidebarBody
              collapsed={false}
              onNavigate={onCloseMobile}
              footer={
                <div className="flex items-center justify-between pl-2">
                  <span className={clsx('truncate text-2xs', systemStatusError ? 'text-[#f87171]' : 'text-subtle')}>{versionText}</span>
                  <button
                    type="button"
                    onClick={onCloseMobile}
                    aria-label="Close navigation"
                    className="flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-raised hover:text-text"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              }
            />
          </aside>
        </div>
      )}
    </>
  );
}
