import { useEffect, useState } from 'react';
import { wsUrl } from '@/api/client';
import { parseJobEvent } from '@/lib/jobReducer';
import { useProjectsStore } from '@/store/projectsStore';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * Subscribe to `/api/ws/events` (job + stage events for every job) and feed
 * them into the projects store. Reconnects forever with backoff.
 */
export function useGlobalEvents(enabled = true): boolean {
  const [connected, setConnected] = useState(false);
  const applyEvent = useProjectsStore((s) => s.applyEvent);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl('/api/ws/events'));
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (m) => {
        const ev = parseJobEvent(m.data);
        if (ev) applyEvent(ev);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) schedule();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };
    const schedule = () => {
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [enabled, applyEvent]);

  return connected;
}
