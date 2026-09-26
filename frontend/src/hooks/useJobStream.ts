import { useEffect, useReducer, useRef, useState } from 'react';
import { wsUrl } from '@/api/client';
import { api } from '@/api/endpoints';
import { isJobActive, type Job } from '@/api/types';
import { initialJobStreamState, jobStreamReducer, parseJobEvent } from '@/lib/jobReducer';

export interface JobStream {
  job: Job | null;
  logLines: string[];
  logSeq: number;
  connected: boolean;
  /** True once the first snapshot arrived (or the job was fetched over HTTP). */
  ready: boolean;
  attempts: number;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

/**
 * Subscribe to `/api/ws/jobs/{id}`. Handles `snapshot` first, then `stage` /
 * `log` / `job` events. Reconnects with backoff while the job is active; when
 * the server closes the socket after the terminal event we stop reconnecting.
 * Log gaps after a reconnect are backfilled from `/log`.
 */
export function useJobStream(jobId: string | null | undefined): JobStream {
  const [state, dispatch] = useReducer(jobStreamReducer, initialJobStreamState);
  const [connected, setConnected] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const jobRef = useRef<Job | null>(null);
  jobRef.current = state.job;

  useEffect(() => {
    dispatch({ type: 'reset' });
    setConnected(false);
    setAttempts(0);
    if (!jobId) return;

    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawTerminal = false;

    const backfill = () => {
      api
        .jobLog(jobId, 2000)
        .then((text) => {
          if (closed) return;
          const lines = text.split(/\r?\n/);
          if (lines.length && lines[lines.length - 1] === '') lines.pop();
          dispatch({ type: 'backfillLog', lines });
        })
        .catch(() => {
          /* log may not exist yet */
        });
    };

    const fetchJobOnce = () => {
      api
        .getJob(jobId)
        .then((job) => {
          if (closed) return;
          dispatch({ type: 'setJob', job });
          if (!isJobActive(job)) sawTerminal = true;
        })
        .catch(() => {
          /* ignore */
        });
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl(`/api/ws/jobs/${encodeURIComponent(jobId)}`));
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        if (closed) return;
        setConnected(true);
        const wasReconnect = attempt > 0;
        attempt = 0;
        setAttempts(0);
        // After a reconnect the stream may have gaps: re-pull the tail of the log.
        if (wasReconnect) backfill();
      };
      ws.onmessage = (msg) => {
        const ev = parseJobEvent(msg.data);
        if (!ev) return;
        dispatch({ type: 'event', event: ev });
        if ((ev.type === 'job' || ev.type === 'snapshot') && ev.job && !isJobActive(ev.job)) {
          sawTerminal = true;
        }
      };
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        if (sawTerminal || (jobRef.current && !isJobActive(jobRef.current))) {
          // Terminal: pull the final log once so nothing is missing.
          backfill();
          return;
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      setAttempts(attempt);
      // While disconnected keep the job state fresh over HTTP so the UI does not freeze.
      fetchJobOnce();
      timer = setTimeout(() => {
        if (jobRef.current && !isJobActive(jobRef.current)) {
          backfill();
          return;
        }
        backfill();
        connect();
      }, delay);
    };

    // Kick off with an HTTP fetch too so the page renders before the socket connects.
    fetchJobOnce();
    backfill();
    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [jobId]);

  return {
    job: state.job,
    logLines: state.logLines,
    logSeq: state.logSeq,
    connected,
    ready: state.hasSnapshot || state.job !== null,
    attempts,
  };
}
