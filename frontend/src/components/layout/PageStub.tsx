import type { ReactNode } from 'react';
import { Construction } from 'lucide-react';
import { PageContainer } from './PageContainer';
import { PageHeader } from './PageHeader';

export interface PageStubProps {
  icon: ReactNode;
  title: string;
  description: string;
}

/** Placeholder used by the temporary page stubs until each page owner replaces its page. */
export function PageStub({ icon, title, description }: PageStubProps) {
  return (
    <PageContainer>
      <PageHeader icon={icon} title={title} description={description} />
      <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-border px-4 py-3 text-xs text-subtle">
        <Construction aria-hidden="true" className="size-4 shrink-0" />
        This page is not implemented yet.
      </div>
    </PageContainer>
  );
}
