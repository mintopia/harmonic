import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildApp, type App } from '../src/server/app.js';
import { logger } from '../src/logger.js';

describe('every 5xx is logged with an error id', () => {
  let app: App;
  let dataDir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-test-'));
    app = await buildApp({ dataDir });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const loggedAttributes = () => errorSpy.mock.calls.map((call: unknown[]) => call[1] as Record<string, unknown>);

  it('logs a response that fails its response schema', async () => {
    app.get('/api/test-bad-response', { schema: { response: { 200: z.object({ count: z.number() }) } } }, async () => ({ count: 'many' }) as never);

    const response = await app.inject({ method: 'GET', url: '/api/test-bad-response' });

    expect(response.statusCode).toBe(500);
    const id = response.json().error.id as string;
    expect(id).toEqual(expect.any(String));
    expect(loggedAttributes()).toEqual([
      expect.objectContaining({ errorId: id, status: 500, method: 'GET', route: '/api/test-bad-response', url: '/api/test-bad-response' }),
    ]);
    expect(loggedAttributes()[0]?.stack).toEqual(expect.any(String));
  });

  it('includes the error id in an unexpected-exception response without leaking the message', async () => {
    app.get('/api/test-throws', async () => {
      throw new Error('secret detail');
    });

    const response = await app.inject({ method: 'GET', url: '/api/test-throws' });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toEqual({ code: 'internal', message: 'internal server error', id: expect.any(String) });
    expect(response.body).not.toContain('secret detail');
    expect(loggedAttributes()).toHaveLength(1);
    expect(loggedAttributes()[0]).toEqual(expect.objectContaining({ errorId: body.error.id, route: '/api/test-throws' }));
  });

  it('logs a stream that fails after the response has started', async () => {
    app.get('/api/test-stream-fails', async (_req, reply) => {
      let reads = 0;
      const stream = new Readable({
        read() {
          reads += 1;
          if (reads === 1) this.push('partial');
          else this.destroy(new Error('disk vanished mid-stream'));
        },
      });
      return reply.type('text/plain').send(stream);
    });

    await app.inject({ method: 'GET', url: '/api/test-stream-fails' }).catch(() => undefined);

    expect(errorSpy.mock.calls).toEqual([[expect.stringContaining('disk vanished mid-stream'), expect.objectContaining({ errorId: expect.any(String), stack: expect.any(String) })]]);
  });

  it('logs a 5xx a handler sends itself', async () => {
    app.get('/api/test-sends-502', async (_req, reply) => reply.status(502).send({ error: { code: 'upstream', message: 'bad gateway' } }));

    const response = await app.inject({ method: 'GET', url: '/api/test-sends-502' });

    expect(response.statusCode).toBe(502);
    expect(loggedAttributes()).toEqual([expect.objectContaining({ status: 502, route: '/api/test-sends-502' })]);
  });

  it('answers a malformed JSON body with 400 instead of a logged 500', async () => {
    app.post('/api/test-json', async () => ({ ok: true }));

    const response = await app.inject({ method: 'POST', url: '/api/test-json', headers: { 'content-type': 'application/json' }, payload: '{nope' });

    expect(response.statusCode).toBe(400);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not log a 4xx or log a handled 500 twice', async () => {
    app.get('/api/test-missing', async () => {
      throw new Error('boom');
    });

    await app.inject({ method: 'GET', url: '/api/test-missing' });
    await app.inject({ method: 'GET', url: '/api/nope-not-a-route' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
