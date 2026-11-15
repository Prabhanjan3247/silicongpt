import { useLocation } from 'react-router-dom';
import { ChevronRight, Menu } from 'lucide-react';
import { routeForPath } from '../../routes';
import { Button } from '../ui/Button';
import { ProjectSwitcher } from './ProjectSwitcher';
import { SimulatorSelector } from './SimulatorSelector';
import { StatusPills } from './StatusPills';

export interface TopBarProps {
  /** Opens the mobile navigation drawer. */
  onOpenNav: () => void;
}

/** Current page, project switcher, simulator selector and toolchain / AI status. */
export function TopBar({ onOpenNav }: TopBarProps) {
  const { pathname } = useLocation();
  const route = routeForPath(pathname);
  const Icon = route?.icon;

  return (
    // relative + z-30: backdrop-blur creates a stacking context; keep it (and the project
    // dropdown inside it) above the routed page content.
    <header className="relative z-30 flex h-13 shrink-0 items-center gap-2 border-b border-border bg-surface/75 px-3 backdrop-blur md:gap-3 md:px-4">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Open navigation"
        title="Navigation"
        icon={<Menu />}
        onClick={onOpenNav}
        className="md:hidden"
      />
      {route && Icon && (
        <div className="hidden shrink-0 items-center gap-2 text-[13px] lg:flex">
          <Icon aria-hidden="true" className="size-4 text-accent" />
          <span className="font-semibold text-text">{route.label}</span>
          <ChevronRight aria-hidden="true" className="size-3.5 text-border-strong" />
        </div>
      )}
      <div className="min-w-0 flex-1 sm:flex-none sm:basis-72">
        <ProjectSwitcher />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <SimulatorSelector className="hidden sm:flex" />
        <StatusPills className="hidden sm:flex" />
      </div>
    </header>
  );
}
