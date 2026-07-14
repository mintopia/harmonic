import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('PUT /api/config', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  it('accepts a complete config and persists it', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    const next = { ...current, defaults: { ...current.defaults, workingDir: '/tmp/elsewhere' } };

    const put = await server.api('PUT', '/api/config', next);
    expect(put.status).toBe(200);
    expect(put.body.defaults.workingDir).toBe('/tmp/elsewhere');

    const after = await server.api('GET', '/api/config');
    expect(after.body.defaults.workingDir).toBe('/tmp/elsewhere');
  });

  it('rejects an invalid config atomically: 400, and a prior GET is unaffected', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    const invalid = { ...current, autoRunner: { ...current.autoRunner, maxConcurrentRuns: 0 } };

    const put = await server.api('PUT', '/api/config', invalid);
    expect(put.status).toBe(400);
    expect(put.body).toMatchObject({ error: { code: 'validation' } });

    // No partial write: the old config is exactly what GET still returns.
    const after = await server.api('GET', '/api/config');
    expect(after.body).toEqual(current);
  });

  it('full-replace deletes a record key that a PATCH cannot remove', async () => {
    // Add a price override via PATCH.
    const patched = await server.api('PATCH', '/api/config', {
      prices: { 'gpt-4': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    });
    expect(patched.body.prices['gpt-4']).toBeTruthy();

    // Confirm PATCH alone cannot remove it: an empty `prices` patch deep-merges
    // onto the existing prices object and changes nothing.
    const noopPatch = await server.api('PATCH', '/api/config', { prices: {} });
    expect(noopPatch.body.prices['gpt-4']).toBeTruthy();

    // A full-replace PUT that omits the key actually deletes it.
    const current = (await server.api('GET', '/api/config')).body;
    const { 'gpt-4': _dropped, ...pricesWithoutGpt4 } = current.prices;
    const put = await server.api('PUT', '/api/config', { ...current, prices: pricesWithoutGpt4 });
    expect(put.status).toBe(200);
    expect(put.body.prices['gpt-4']).toBeUndefined();

    const after = await server.api('GET', '/api/config');
    expect(after.body.prices['gpt-4']).toBeUndefined();
  });

  it('full-replace deletes a harness env var that a PATCH cannot remove', async () => {
    const withEnv = await server.api('PATCH', '/api/config', {
      harnesses: { claude: { env: { FOO: 'bar' } } },
    });
    expect(withEnv.body.harnesses.claude.env.FOO).toBe('bar');

    const current = (await server.api('GET', '/api/config')).body;
    const next = {
      ...current,
      harnesses: { ...current.harnesses, claude: { ...current.harnesses.claude, env: {} } },
    };
    const put = await server.api('PUT', '/api/config', next);
    expect(put.status).toBe(200);
    expect(put.body.harnesses.claude.env.FOO).toBeUndefined();

    const after = await server.api('GET', '/api/config');
    expect(after.body.harnesses.claude.env.FOO).toBeUndefined();
  });

  it('pokes the Auto-Runner on success, same as PATCH', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'ping', state: 'ready' });

    const current = (await server.api('GET', '/api/config')).body;
    const next = { ...current, autoRunner: { ...current.autoRunner, enabled: true } };
    const put = await server.api('PUT', '/api/config', next);
    expect(put.status).toBe(200);

    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return task.state === 'running' || task.state === 'awaiting-review';
    });
  });
});
