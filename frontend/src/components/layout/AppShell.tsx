import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { SettingsDrawer } from './SettingsDrawer';
import { ConfirmHost, Toasts } from '@/components/ui/Toasts';
import { useGlobalEvents } from '@/hooks/useGlobalEvents';
import { useEngineStatus } from '@/hooks/useEngineStatus';
import { Note } from '@/components/ui';

export function AppShell() {
  const wsConnected = useGlobalEvents(true);
  const engine = useEngineStatus();
  return (
    <div className="flex h-full min-h-0 min-w-[1000px]">
      <Sidebar wsConnected={wsConnected} engine={engine} />
      <main className="flex-1 min-w-0 overflow-y-auto">
        {engine.state === 'error' && (
          <div className="px-6 pt-4">
            <Note kind="error">
              <strong>Engine unavailable.</strong> {engine.message ?? 'The local engine is not responding.'} Start it with{' '}
              <code className="code">splat360 serve</code> or check the API base in Settings.
            </Note>
          </div>
        )}
        <div className="px-6 py-5 max-w-[1500px]">
          <Outlet />
        </div>
      </main>
      <SettingsDrawer engine={engine} />
      <Toasts />
      <ConfirmHost />
    </div>
  );
}
