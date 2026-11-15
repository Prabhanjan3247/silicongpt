import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { usePersistentState } from '../../lib/usePersistentState';
import { LoadingState } from '../ui/Spinner';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/**
 * Application frame: collapsible sidebar, top bar and the routed page area.
 * The <main> element is the scroll container; pages that manage their own scrolling can use
 * `h-full` (see PageContainer `fill`).
 */
export function AppShell() {
  const [collapsed, setCollapsed] = usePersistentState('sgpt.sidebarCollapsed', false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-dvh overflow-hidden text-text">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-sm font-medium text-[#03141c] focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenNav={() => setMobileOpen(true)} />
        <main id="main" className="relative min-h-0 flex-1 overflow-auto">
          <RouteErrorBoundary key={location.pathname}>
            <Suspense fallback={<LoadingState label="Loading page…" minHeight="60vh" />}>
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        </main>
      </div>
    </div>
  );
}
