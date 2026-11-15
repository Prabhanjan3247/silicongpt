import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { OctagonAlert, RefreshCw } from 'lucide-react';
import { Button, buttonClasses } from '../ui/Button';
import { PageContainer } from './PageContainer';

interface RouteErrorBoundaryProps {
  children: ReactNode;
}

interface RouteErrorBoundaryState {
  error: Error | null;
}

/** Catches render errors (and failed lazy page chunks) of the current route. Keyed by path in AppShell. */
export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('SiliconGPT page error:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunkError = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message);
    return (
      <PageContainer width="narrow">
        <div role="alert" className="mt-8 rounded-2xl border border-fail/35 bg-fail/[0.06] p-6">
          <div className="flex items-start gap-3">
            <OctagonAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fail" />
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold text-[#fecaca]">
                {chunkError ? 'This page could not be loaded' : 'This page crashed'}
              </h1>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                {chunkError
                  ? 'The page bundle failed to load (the frontend may have been rebuilt). Reloading usually fixes it.'
                  : 'An unexpected error occurred while rendering this page. The rest of the app still works.'}
              </p>
              <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs text-[#fca5a5]">
                {error.message || error.name}
              </pre>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" icon={<RefreshCw />} onClick={() => window.location.reload()}>
                  Reload page
                </Button>
                <Link to="/" className={buttonClasses({ variant: 'secondary' })}>
                  Go to dashboard
                </Link>
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }
}
