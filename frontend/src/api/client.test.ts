import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiBase, apiUrl, normaliseDetail, request, setApiBaseOverride, wsUrl } from './client';

describe('api base resolution', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.splat360;
  });
  afterEach(() => {
    localStorage.clear();
    delete window.splat360;
    vi.restoreAllMocks();
  });

  it('defaults to same origin (empty base)', () => {
    expect(apiBase()).toBe('');
    expect(apiUrl('/api/health')).toBe('/api/health');
  });

  it('uses the persisted browser override, trimming trailing slashes', () => {
    setApiBaseOverride('http://127.0.0.1:8765///');
    expect(apiBase()).toBe('http://127.0.0.1:8765');
    expect(apiUrl('api/projects')).toBe('http://127.0.0.1:8765/api/projects');
    setApiBaseOverride('   ');
    expect(apiBase()).toBe('');
  });

  it('prefers the desktop bridge over the override', () => {
    setApiBaseOverride('http://override:1');
    window.splat360 = { apiBase: 'http://127.0.0.1:53211/' } as unknown as Window['splat360'];
    expect(apiBase()).toBe('http://127.0.0.1:53211');
  });

  it('serialises query params and skips empty ones', () => {
    expect(apiUrl('/api/x', { a: 1, b: 'two words', c: undefined, d: null, e: '' })).toBe('/api/x?a=1&b=two%20words');
  });

  it('derives websocket urls from the http base or the page origin', () => {
    setApiBaseOverride('https://engine.local:9000');
    expect(wsUrl('/api/ws/events')).toBe('wss://engine.local:9000/api/ws/events');
    setApiBaseOverride('');
    expect(wsUrl('/api/ws/events')).toMatch(/^ws:\/\/.+\/api\/ws\/events$/);
  });
});

describe('normaliseDetail', () => {
  it('handles string, validation list and fallback', () => {
    expect(normaliseDetail({ detail: 'boom' }, 'f')).toBe('boom');
    expect(normaliseDetail({ detail: [{ loc: ['body', 'tag_size_mm'], msg: 'too big' }] }, 'f')).toBe('tag_size_mm: too big');
    expect(normaliseDetail('plain text', 'f')).toBe('plain text');
    expect(normaliseDetail(null, 'fallback')).toBe('fallback');
  });
});

describe('request', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws ApiError with the server detail on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'nope' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    await expect(request('/api/projects/x/run', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 409, detail: 'nope', isConflict: true });
  });

  it('throws a network ApiError (status 0) when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await request('/api/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isNetwork).toBe(true);
  });

  it('returns parsed JSON on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(request<{ ok: boolean }>('/api/health')).resolves.toEqual({ ok: true });
  });
});
