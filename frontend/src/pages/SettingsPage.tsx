/**
 * Settings (/settings): toolchain, sandbox and AI status reported by GET /api/system/status, plus
 * browser-local UI preferences. Nothing on this page is invented: every value is the backend's
 * own report (or a localStorage preference of this browser).
 */
import { useState } from 'react';
import { Info, RefreshCw, Settings } from 'lucide-react';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { KeyValue } from '../components/ui/KeyValue';
import { AIStatusCard } from '../components/settings/AIStatusCard';
import { PreferencesCard } from '../components/settings/PreferencesCard';
import { SandboxCard, readLimits } from '../components/settings/SandboxCard';
import { ToolchainCard } from '../components/settings/ToolchainCard';
import { API_BASE } from '../services/api';
import { useProject } from '../state/ProjectContext';

export default function SettingsPage() {
  const { systemStatus, systemStatusLoading, systemStatusError, refreshSystemStatus } = useProject();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshSystemStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const loading = systemStatusLoading && !systemStatus;

  return (
    <PageContainer>
      <PageHeader
        icon={<Settings />}
        title="Settings"
        description="Toolchain versions, sandbox isolation and AI configuration as reported by the backend, plus preferences stored in this browser."
        actions={
          <Button icon={<RefreshCw />} loading={refreshing} onClick={() => void onRefresh()}>
            Refresh status
          </Button>
        }
      />

      {systemStatusError && (
        <ErrorBanner
          error={systemStatusError}
          title={systemStatus ? 'Backend status could not be refreshed (showing the last answer)' : 'Backend status unavailable'}
          onRetry={() => void onRefresh()}
          retrying={refreshing}
          className="mb-4"
        />
      )}

      <div className="grid gap-4">
        <ToolchainCard status={systemStatus} loading={loading} />

        <div className="grid items-start gap-4 xl:grid-cols-2">
          <AIStatusCard ai={systemStatus?.ai ?? null} loading={loading} />
          <SandboxCard sandbox={systemStatus?.sandbox ?? null} limits={readLimits(systemStatus)} loading={loading} />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-2">
          <PreferencesCard systemStatus={systemStatus} />
          <Card icon={<Info />} title="About this instance">
            <KeyValue
              columns={2}
              dense
              items={[
                { label: 'Backend version', value: systemStatus?.version ?? null, mono: true },
                { label: 'API base URL', value: API_BASE, mono: true },
                {
                  label: 'Status endpoint',
                  value: `${API_BASE}/system/status`,
                  mono: true,
                },
                {
                  label: 'Status refresh',
                  value: 'Every 60 s in the background (every 10 s while the backend is unreachable)',
                  wrap: true,
                },
              ]}
            />
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
