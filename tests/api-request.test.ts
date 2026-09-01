import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';

const fakeFetch = (body: string | null, init: ResponseInit) =>
  vi.fn().mockResolvedValue(new Response(body, init));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api request()', () => {
  it('throws an honest error (not a null destructure) on an empty 2xx body', async () => {
    vi.stubGlobal('fetch', fakeFetch('', { status: 200 }));
    await expect(api.tasks()).rejects.toThrow(/Empty response from GET \/api\/tasks/);
  });

  it('parses and returns a normal JSON body', async () => {
    vi.stubGlobal('fetch', fakeFetch(JSON.stringify({ tasks: [{ id: 1 }] }), { status: 200 }));
    await expect(api.tasks()).resolves.toEqual({ tasks: [{ id: 1 }] });
  });

  it('lets the board explicitly request only open tasks without changing the default API request', async () => {
    const fetch = fakeFetch(JSON.stringify({ tasks: [] }), { status: 200 });
    vi.stubGlobal('fetch', fetch);

    await api.tasks({ workspaceId: 7, state: 'open' });
    expect(fetch).toHaveBeenCalledWith('/api/tasks?workspaceId=7&state=open', { method: 'GET' });
  });

  it('surfaces the server error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(JSON.stringify({ error: { message: 'task 99999 not found' } }), { status: 404 }),
    );
    await expect(api.task(99999)).rejects.toThrow('task 99999 not found');
  });

  it('allows a genuine 204 No Content to resolve (empty body is legitimate there)', async () => {
    vi.stubGlobal('fetch', fakeFetch(null, { status: 204 }));
    await expect(api.deletePermissionRule(1)).resolves.toBeNull();
  });
});

describe('paginated list clients (epics, maps)', () => {
  it('epics() requests the bare workspace path when it wants the whole list', async () => {
    const fetch = fakeFetch(JSON.stringify({ epics: [], total: 0 }), { status: 200 });
    vi.stubGlobal('fetch', fetch);
    await api.epics(7);
    expect(fetch).toHaveBeenCalledWith('/api/workspaces/7/epics', { method: 'GET' });
  });

  it('epics() threads limit/offset/q so the Board can page and search', async () => {
    const fetch = fakeFetch(JSON.stringify({ epics: [], total: 0 }), { status: 200 });
    vi.stubGlobal('fetch', fetch);
    await api.epics(7, { limit: 100, offset: 200, q: 'operator UI' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces/7/epics?limit=100&offset=200&q=operator+UI',
      { method: 'GET' },
    );
  });

  it('maps() requests the bare path by default', async () => {
    const fetch = fakeFetch(JSON.stringify({ maps: [], total: 0 }), { status: 200 });
    vi.stubGlobal('fetch', fetch);
    await api.maps();
    expect(fetch).toHaveBeenCalledWith('/api/maps', { method: 'GET' });
  });

  it('maps() threads workspaceId/limit/offset/q into the query', async () => {
    const fetch = fakeFetch(JSON.stringify({ maps: [], total: 0 }), { status: 200 });
    vi.stubGlobal('fetch', fetch);
    await api.maps({ workspaceId: 3, limit: 50, offset: 50, q: 'Wayfinder' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/maps?workspaceId=3&limit=50&offset=50&q=Wayfinder',
      { method: 'GET' },
    );
  });
});
