import { NavLink, Link } from 'react-router-dom';
import { Activity, BookOpen, Box, FolderKanban, Plus, QrCode, Settings, Stethoscope, Wifi, WifiOff } from 'lucide-react';
import { cx } from '@/components/ui';
import { useUiStore } from '@/store/uiStore';
import type { EngineState } from '@/hooks/useEngineStatus';
import { isDesktop } from '@/lib/desktop';

const NAV = [
  { to: '/', label: 'Projects', icon: FolderKanban, end: true },
  { to: '/tags', label: 'Tag printer', icon: QrCode },
  { to: '/guide', label: 'Capture guide', icon: BookOpen },
  { to: '/doctor', label: 'Environment', icon: Stethoscope },
];

export function Sidebar({ wsConnected, engine }: { wsConnected: boolean; engine: EngineState }) {
  const openSettings = useUiStore((s) => s.setSettingsOpen);
  const engineDot = engine.state === 'ready' ? 'bg-ok' : engine.state === 'starting' ? 'bg-warn animate-pulse' : 'bg-danger';
  const engineLabel = engine.state === 'ready' ? 'Engine ready' : engine.state === 'starting' ? 'Engine starting…' : 'Engine offline';
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel" aria-label="Primary">
      <div className="flex items-center gap-2 px-4 py-4 border-b border-line">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-accent/15 text-accent">
          <Box className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-4">Splat360 Studio</div>
          <div className="text-2xs text-faint leading-4">360° video → Gaussian splats</div>
        </div>
      </div>
      <div className="px-3 pt-3">
        <Link to="/projects/new" className="btn-primary w-full justify-center">
          <Plus className="h-4 w-4" /> New project
        </Link>
      </div>
      <nav className="flex flex-col gap-0.5 px-3 py-3" aria-label="Sections">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cx('flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium', isActive ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel2 hover:text-ink')
            }
          >
            <Icon className="h-4 w-4" /> {label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t border-line px-3 py-3 text-2xs text-muted space-y-1.5">
        <div className="flex items-center gap-2" title={engine.message ?? engineLabel}>
          <span className={cx('h-2 w-2 rounded-full', engineDot)} aria-hidden />
          <span className="truncate">{engineLabel}</span>
          {engine.health?.version && <span className="ml-auto font-mono text-faint">v{engine.health.version}</span>}
        </div>
        <div className="flex items-center gap-2" title={wsConnected ? 'Live updates connected' : 'Live updates disconnected; reconnecting'}>
          {wsConnected ? <Wifi className="h-3 w-3 text-ok" /> : <WifiOff className="h-3 w-3 text-faint" />}
          <span>{wsConnected ? 'Live updates on' : 'Live updates off'}</span>
          <Activity className="ml-auto h-3 w-3 text-faint" aria-hidden />
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-faint">{isDesktop() ? `Desktop ${window.splat360?.version ?? ''}` : 'Browser mode'}</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => openSettings(true)} aria-label="Open settings">
            <Settings className="h-3.5 w-3.5" /> Settings
          </button>
        </div>
      </div>
    </aside>
  );
}
