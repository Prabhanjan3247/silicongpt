import { useLocation } from 'react-router-dom';
import { Compass, LayoutDashboard } from 'lucide-react';
import { ButtonLink } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { PageContainer } from './PageContainer';

/** Fallback for unknown routes. */
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <PageContainer width="narrow">
      <EmptyState
        className="mt-10"
        icon={<Compass />}
        title="Page not found"
        description={
          <>
            There is no page at <code className="font-mono text-[#a5f3fc]">{pathname}</code>.
          </>
        }
        action={
          <ButtonLink to="/" variant="primary" icon={<LayoutDashboard />}>
            Go to dashboard
          </ButtonLink>
        }
      />
    </PageContainer>
  );
}
