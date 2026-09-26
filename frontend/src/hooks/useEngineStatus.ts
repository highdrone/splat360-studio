import { useEffect, useState } from 'react';
import { api } from '@/api/endpoints';
import { errorMessage } from '@/api/client';
import type { Health } from '@/api/types';
import { bridge } from '@/lib/desktop';

export interface EngineState {
  state: 'starting' | 'ready' | 'error';
  message?: string;
  health: Health | null;
  refresh: () => void;
}

/** Poll /api/health (and listen to the desktop bridge's engine status). */
export function useEngineStatus(pollMs = 15000): EngineState {
  const [state, setState] = useState<EngineState['state']>('starting');
  const [message, setMessage] = useState<string | undefined>();
  const [health, setHealth] = useState<Health | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    api
      .health(ctrl.signal)
      .then((h) => {
        if (!alive) return;
        setHealth(h);
        setState(h.ok ? 'ready' : 'error');
        setMessage(h.ok ? undefined : 'Engine reports not ok.');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState('error');
        setMessage(errorMessage(e));
      });
    const t = setTimeout(() => alive && setTick((x) => x + 1), pollMs);
    return () => {
      alive = false;
      ctrl.abort();
      clearTimeout(t);
    };
  }, [tick, pollMs]);

  useEffect(() => {
    const b = bridge();
    if (!b?.onEngineStatus) return;
    const off = b.onEngineStatus((s) => {
      if (s.state === 'ready') setTick((x) => x + 1);
      else {
        setState(s.state);
        setMessage(s.message);
      }
    });
    return off;
  }, []);

  return { state, message, health, refresh: () => setTick((x) => x + 1) };
}
