/**
 * Navigation registry (CONTRACTS.md section 6): routes in sidebar order. Used by the Sidebar
 * and the TopBar; App.tsx maps each path to its lazily loaded page.
 */
import {
  AudioWaveform,
  Bug,
  FileCode,
  FileText,
  FolderKanban,
  Gauge,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export type NavGroup = 'workspace' | 'design' | 'verify' | 'improve' | 'system';

export interface NavRoute {
  path: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Short tooltip text. */
  hint: string;
}

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  workspace: 'Workspace',
  design: 'Design',
  verify: 'Verify',
  improve: 'Improve',
  system: 'System',
};

export const NAV_ROUTES: readonly NavRoute[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, group: 'workspace', hint: 'Run trends and recent activity' },
  { path: '/projects', label: 'Projects', icon: FolderKanban, group: 'workspace', hint: 'Projects and example designs' },
  { path: '/studio', label: 'RTL Editor', icon: FileCode, group: 'design', hint: 'Edit, lint and compile RTL' },
  { path: '/generator', label: 'AI Generator', icon: Sparkles, group: 'design', hint: 'Spec to RTL and testbench' },
  { path: '/verification', label: 'Verification', icon: ShieldCheck, group: 'verify', hint: 'Simulate and inspect checks' },
  { path: '/waveforms', label: 'Waveforms', icon: AudioWaveform, group: 'verify', hint: 'VCD waveform viewer' },
  { path: '/debugger', label: 'Debugger', icon: Bug, group: 'verify', hint: 'AI root-cause analysis' },
  { path: '/optimize', label: 'Optimize', icon: Gauge, group: 'improve', hint: 'Synthesis stats and AI optimization' },
  { path: '/reports', label: 'Reports', icon: FileText, group: 'improve', hint: 'Verification reports' },
  { path: '/settings', label: 'Settings', icon: Settings, group: 'system', hint: 'Toolchain, sandbox and AI status' },
];

/** Route entry for a pathname ("/" matches only exactly; others also match sub-paths). */
export function routeForPath(pathname: string): NavRoute | undefined {
  if (pathname === '/' || pathname === '') return NAV_ROUTES[0];
  return NAV_ROUTES.find((r) => r.path !== '/' && (pathname === r.path || pathname.startsWith(`${r.path}/`)));
}
