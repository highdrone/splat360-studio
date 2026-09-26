/**
 * Single typed HTTP client for the engine API.
 *
 * Base URL resolution: `window.splat360?.apiBase ?? ''` (empty = same origin),
 * with an optional override persisted in localStorage for browser use.
 */

const OVERRIDE_KEY = 'splat360.apiBaseOverride';

export function getApiBaseOverride(): string {
  try {
    return localStorage.getItem(OVERRIDE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setApiBaseOverride(value: string): void {
  try {
    const v = value.trim().replace(/\/+$/, '');
    if (v) localStorage.setItem(OVERRIDE_KEY, v);
    else localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Resolve the API base. Desktop bridge wins, then the browser override, else same origin. */
export function apiBase(): string {
  if (typeof window !== 'undefined' && window.splat360?.apiBase) {
    return window.splat360.apiBase.replace(/\/+$/, '');
  }
  return getApiBaseOverride();
}

/** Build an absolute (or origin-relative) URL for an API path such as `/api/projects`. */
export function apiUrl(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  const base = apiBase();
  const p = path.startsWith('/') ? path : `/${path}`;
  let url = `${base}${p}`;
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

/** Derive the websocket URL for an API path from the HTTP base (http -> ws, https -> wss). */
export function wsUrl(path: string): string {
  const base = apiBase();
  const p = path.startsWith('/') ? path : `/${path}`;
  if (base) {
    return base.replace(/^http(s?):/i, 'ws$1:') + p;
  }
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${p}`;
  }
  return `ws://127.0.0.1:8765${p}`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly raw: unknown;

  constructor(status: number, detail: string, raw?: unknown) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.raw = raw;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

interface ValidationItem {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

/** Turn FastAPI's `{"detail": ...}` (string or validation list) into a readable message. */
export function normaliseDetail(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      const parts = (d as ValidationItem[]).map((it) => {
        const loc = (it.loc ?? []).filter((x) => x !== 'body').join('.');
        return loc ? `${loc}: ${it.msg ?? 'invalid'}` : (it.msg ?? 'invalid');
      });
      if (parts.length) return parts.join('; ');
    }
    if (d && typeof d === 'object') return JSON.stringify(d);
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  return fallback;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (res.status === 204) return null;
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

/** Core request. Throws `ApiError` for non-2xx and for network failures (status 0). */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = apiUrl(path, opts.query);
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', headers, body, signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, `Cannot reach the engine at ${apiBase() || window.location.origin}. Is it running?`, e);
  }
  const parsed = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, normaliseDetail(parsed, `${res.status} ${res.statusText || 'Request failed'}`), parsed);
  }
  return parsed as T;
}

/** Fetch a binary response (e.g. the tag sheet PDF). */
export async function requestBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  const url = apiUrl(path, opts.query);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', headers, body, signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, `Cannot reach the engine at ${apiBase() || window.location.origin}. Is it running?`, e);
  }
  if (!res.ok) {
    const parsed = await parseBody(res);
    throw new ApiError(res.status, normaliseDetail(parsed, `${res.status} ${res.statusText || 'Request failed'}`), parsed);
  }
  return res.blob();
}

/** Fetch plain text (job log). */
export async function requestText(path: string, opts: RequestOptions = {}): Promise<string> {
  const url = apiUrl(path, opts.query);
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', signal: opts.signal, headers: { Accept: 'text/plain' } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, `Cannot reach the engine at ${apiBase() || window.location.origin}. Is it running?`, e);
  }
  if (!res.ok) {
    const parsed = await parseBody(res);
    throw new ApiError(res.status, normaliseDetail(parsed, `${res.status} ${res.statusText || 'Request failed'}`), parsed);
  }
  return res.text();
}

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

/** Multipart upload with progress via XHR (fetch has no upload progress). */
export function upload<T>(
  path: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  fieldName = 'file',
): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', apiUrl(path));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (ev) => {
      if (onProgress) onProgress(ev.loaded, ev.lengthComputable ? ev.total : file.size);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: network error.'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        parsed = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
      else reject(new ApiError(xhr.status, normaliseDetail(parsed, `${xhr.status} Upload failed`), parsed));
    };
    const form = new FormData();
    form.append(fieldName, file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.detail;
  if (e instanceof Error) return e.message;
  return String(e);
}
