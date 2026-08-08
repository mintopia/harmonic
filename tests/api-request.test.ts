import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';

/**
 * The API client's shared `request()` (web/src/api.ts) is internal, so these
 * exercise it through a public method. The regression under test: a successful
 * response with an empty body used to be returned as a bare `null`, which blew
 * up far away the moment a caller destructured it — surfacing as Firefox's
 * cryptic "null has no properties". It must now fail honestly and locally.
 */
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
