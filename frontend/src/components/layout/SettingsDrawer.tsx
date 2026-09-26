import { useEffect, useState } from 'react';
import { Moon, RefreshCw, Sun, X } from 'lucide-react';
import { useUiStore, toast } from '@/store/uiStore';
import { getApiBaseOverride, setApiBaseOverride, apiBase } from '@/api/client';
import { isDesktop } from '@/lib/desktop';
import { Field, PathChip, Toggle } from '@/components/ui';
import type { EngineState } from '@/hooks/useEngineStatus';

export function SettingsDrawer({ engine }: { engine: EngineState }) {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const [override, setOverride] = useState(getApiBaseOverride());

  useEffect(() => {
    if (open) setOverride(getApiBaseOverride());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const desktop = isDesktop();

  const applyOverride = () => {
    setApiBaseOverride(override);
    toast.info('API base updated', override.trim() ? `Requests now go to ${override.trim()}` : 'Using the same origin as the page.');
    engine.refresh();
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <aside role="dialog" aria-modal="true" aria-label="Settings" className="h-full w-[380px] max-w-full overflow-y-auto border-l border-line bg-panel p-5 shadow-2xl">
        <header className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button type="button" className="btn-icon btn-ghost" onClick={() => setOpen(false)} aria-label="Close settings" autoFocus>
            <X className="h-4 w-4" />
          </button>
        </header>

        <section className="space-y-3">
          <h3 className="panel-title">Appearance</h3>
          <div className="flex items-center justify-between">
            <span className="text-[13px] flex items-center gap-2">
              {theme === 'dark' ? <Moon className="h-4 w-4 text-muted" /> : <Sun className="h-4 w-4 text-muted" />}
              {theme === 'dark' ? 'Dark theme' : 'Light theme'}
            </span>
            <Toggle checked={theme === 'light'} onChange={(v) => setTheme(v ? 'light' : 'dark')} label="Light" />
          </div>
          <p className="help">Dark is the default for long sessions; the choice is remembered on this device.</p>
        </section>

        <section className="space-y-3 mt-6">
          <h3 className="panel-title">Engine</h3>
          <div className="text-xs space-y-2">
            <div className="flex justify-between gap-3">
              <span className="text-muted">Status</span>
              <span className={engine.state === 'ready' ? 'text-ok' : engine.state === 'starting' ? 'text-warn' : 'text-danger'}>
                {engine.state === 'ready' ? 'ready' : engine.state === 'starting' ? 'starting' : 'unreachable'}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Engine version</span>
              <span className="font-mono">{engine.health?.version ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">PID</span>
              <span className="font-mono">{engine.health?.pid ?? '—'}</span>
            </div>
            <div>
              <div className="text-muted mb-1">Data directory</div>
              {engine.health?.data_dir ? <PathChip path={engine.health.data_dir} /> : <span className="text-faint">unknown until the engine answers</span>}
            </div>
            <div>
              <div className="text-muted mb-1">API base in use</div>
              <code className="code">{apiBase() || `${window.location.origin} (same origin)`}</code>
            </div>
            {engine.message && engine.state === 'error' && <div className="text-danger break-words">{engine.message}</div>}
          </div>
          <button type="button" className="btn-secondary btn-sm" onClick={() => engine.refresh()}>
            <RefreshCw className="h-3 w-3" /> Re-check
          </button>
        </section>

        {!desktop && (
          <section className="space-y-3 mt-6">
            <h3 className="panel-title">API base override</h3>
            <Field label="Engine URL" help="Leave empty to use the same origin as this page (the dev server proxies /api). Example: http://127.0.0.1:8765" htmlFor="api-base">
              <input id="api-base" className="input font-mono" value={override} placeholder="http://127.0.0.1:8765" onChange={(e) => setOverride(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyOverride()} />
            </Field>
            <div className="flex gap-2">
              <button type="button" className="btn-primary btn-sm" onClick={applyOverride}>
                Apply
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  setOverride('');
                  setApiBaseOverride('');
                  engine.refresh();
                }}
              >
                Clear
              </button>
            </div>
          </section>
        )}
        {desktop && (
          <section className="mt-6 text-xs text-muted">
            <h3 className="panel-title mb-1">Desktop</h3>
            The desktop shell manages the engine and its port ({window.splat360?.apiBase}). Platform: {window.splat360?.platform}, app version {window.splat360?.version}.
          </section>
        )}
      </aside>
    </div>
  );
}
