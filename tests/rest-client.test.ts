import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createRestClient, RestError, safeErrorReason } from '../src/tracker/rest-client.js';

const scripted = (...responses: Array<Response | Error>) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const http = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init && { init }) });
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { http, calls };
};
const client = (http: Parameters<typeof createRestClient>[0]['http'], sleeps: number[] = []) =>
  createRestClient({ baseUrl: 'https://x.test/api/', headers: { authorization: 'token t' }, http, sleep: async (ms) => void sleeps.push(ms) });
const ok = (body: unknown) => new Response(JSON.stringify(body));
const anything = z.unknown();
const obj = z.object({ a: z.number() });

describe('REST client', () => {
  it('sends auth and a JSON body, and ignores the reply on send', async () => {
    const { http, calls } = scripted(new Response('', { status: 200 }));
    await client(http).send('POST', '/a', { k: 1 });
    expect(calls[0]!.url).toBe('https://x.test/api/a');
    expect(new Headers(calls[0]!.init!.headers).get('authorization')).toBe('token t');
    expect(calls[0]!.init!.body).toBe('{"k":1}');
  });

  it('retries GET on 5xx and network errors with backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    const { http, calls } = scripted(new Response('', { status: 503 }), new Error('ECONNRESET'), ok({ a: 1 }));
    expect(await client(http, sleeps).request('GET', '/a', obj)).toEqual({ a: 1 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it('honours Retry-After on 429, capped', async () => {
    const sleeps: number[] = [];
    const { http } = scripted(new Response('', { status: 429, headers: { 'retry-after': '60' } }), ok({}));
    await client(http, sleeps).request('GET', '/a', anything);
    expect(sleeps).toEqual([5000]);
  });

  it('gives up after the bounded retries with a RestError', async () => {
    const { http, calls } = scripted(...Array.from({ length: 4 }, () => new Response('nope', { status: 500 })));
    await expect(client(http).request('GET', '/a', anything)).rejects.toMatchObject({ name: 'RestError', status: 500 });
    expect(calls).toHaveLength(4);
  });

  it('never retries a POST on 5xx or a network error, since it may have landed', async () => {
    const a = scripted(new Response('', { status: 500 }));
    await expect(client(a.http).send('POST', '/a', {})).rejects.toBeInstanceOf(RestError);
    expect(a.calls).toHaveLength(1);
    const b = scripted(new Error('reset'));
    await expect(client(b.http).send('POST', '/a', {})).rejects.toThrow('reset');
    expect(b.calls).toHaveLength(1);
  });

  it('does not retry a 4xx', async () => {
    const { http, calls } = scripted(new Response('', { status: 404 }));
    await expect(client(http).request('GET', '/a', anything)).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });

  it('paginates until a short page', async () => {
    const { http, calls } = scripted(ok([1, 2]), ok([3]));
    expect(await client(http).paginate('/l?state=all', 2, z.number())).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.url)).toEqual(['https://x.test/api/l?state=all&page=1&limit=2', 'https://x.test/api/l?state=all&page=2&limit=2']);
  });
});

describe('REST client malformed replies', () => {
  it('reports a non-JSON success body with the request', async () => {
    await expect(client(scripted(new Response('<html>')).http).request('GET', '/a', anything)).rejects.toMatchObject({
      name: 'RestError',
      message: expect.stringContaining('GET /a returned non-JSON'),
    });
  });

  it('rejects a reply that does not match the schema, naming the offending path', async () => {
    await expect(client(scripted(ok({ a: 'x' })).http).request('GET', '/a', obj)).rejects.toMatchObject({
      name: 'RestError',
      message: expect.stringContaining('GET /a returned an unexpected shape: a:'),
    });
    await expect(client(scripted(ok({ a: 1 })).http).paginate('/l', 2, z.number())).rejects.toThrow('unexpected shape');
  });

  it('keeps a response body that echoes a credential out of the safe reason', async () => {
    const err = await client(scripted(new Response('bad token s3cret', { status: 401 })).http)
      .request('GET', '/a', anything)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestError);
    expect((err as RestError).message).toContain('s3cret');
    expect(safeErrorReason(err)).toBe('GET /a failed: 401');
  });
});
