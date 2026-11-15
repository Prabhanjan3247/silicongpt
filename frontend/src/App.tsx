import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { NotFound } from './components/layout/NotFound';
import { lazyPage } from './lib/lazyPage';

// Route-level code splitting: each page (and heavy dependencies such as Monaco or recharts that
// only some pages use) is loaded on first visit. Page modules may export default or named.
const DashboardPage = lazyPage(() => import('./pages/DashboardPage'), 'DashboardPage');
const ProjectsPage = lazyPage(() => import('./pages/ProjectsPage'), 'ProjectsPage');
const StudioPage = lazyPage(() => import('./pages/StudioPage'), 'StudioPage');
const GeneratorPage = lazyPage(() => import('./pages/GeneratorPage'), 'GeneratorPage');
const VerificationPage = lazyPage(() => import('./pages/VerificationPage'), 'VerificationPage');
const WaveformsPage = lazyPage(() => import('./pages/WaveformsPage'), 'WaveformsPage');
const DebuggerPage = lazyPage(() => import('./pages/DebuggerPage'), 'DebuggerPage');
const OptimizePage = lazyPage(() => import('./pages/OptimizePage'), 'OptimizePage');
const ReportsPage = lazyPage(() => import('./pages/ReportsPage'), 'ReportsPage');
const SettingsPage = lazyPage(() => import('./pages/SettingsPage'), 'SettingsPage');

/** Routes of CONTRACTS.md section 6. Query parameters (e.g. `?run=`) are read by the pages. */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="studio" element={<StudioPage />} />
        <Route path="generator" element={<GeneratorPage />} />
        <Route path="verification" element={<VerificationPage />} />
        <Route path="waveforms" element={<WaveformsPage />} />
        <Route path="debugger" element={<DebuggerPage />} />
        <Route path="optimize" element={<OptimizePage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
