import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '@/api/client';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 404 is tracked separately so pages can show "not yet" instead of a red error. */
  notFound: boolean;
  status: number | null;
  reload: () => void;
  setData: (d: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * Run an async loader tied to a dependency list; cancels stale requests.
 * `enabled=false` skips loading (keeps previous data).
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  opts: { enabled?: boolean; pollMs?: number } = {},
): AsyncState<T> {
  const { enabled = true, pollMs } = opts;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [status, setStatus] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let alive = true;
    setLoading(true);
    loaderRef
      .current(ctrl.signal)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setNotFound(false);
        setStatus(200);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        const st = e instanceof ApiError ? e.status : null;
        setStatus(st);
        setNotFound(st === 404);
        setError(st === 404 ? null : errorMessage(e));
        if (st === 404) setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (pollMs && pollMs > 0) timer = setTimeout(() => alive && setTick((t) => t + 1), pollMs);
    return () => {
      alive = false;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, tick, pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, notFound, status, reload, setData };
}
