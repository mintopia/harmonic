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

  it('exposes the distributed baseline separately from the effective global config', async () => {
    await server.api('PATCH', '/api/config', { maxAttempts: 7 });

    const layers = await server.api('GET', '/api/config/layers');
    expect(layers.status).toBe(200);
    expect(layers.body.baseline.maxAttempts).toBe(2);
    expect(layers.body.global.maxAttempts).toBe(7);
  });

  it('reverts every global override to the distributed baseline', async () => {
    await server.api('PATCH', '/api/config', { maxAttempts: 7 });

    const reverted = await server.api('DELETE', '/api/config/overrides');
    expect(reverted.status).toBe(200);
    expect(reverted.body.maxAttempts).toBe(2);
    expect((await server.api('GET', '/api/config/layers')).body.global.maxAttempts).toBe(2);
  });

  it('rejects an invalid config atomically: 400, and a prior GET is unaffected', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    const invalid = { ...current, autoRunner: { ...current.autoRunner, maxConcurrentAttempts: 0 } };

    const put = await server.api('PUT', '/api/config', invalid);
    expect(put.status).toBe(400);
    expect(put.body).toMatchObject({ error: { code: 'validation' } });

    const after = await server.api('GET', '/api/config');
    expect(after.body).toEqual(current);
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

  it('rejects a defaultModel that is not one of the harness models', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    const next = {
      ...current,
      harnesses: {
        ...current.harnesses,
        claude: { ...current.harnesses.claude, defaultModel: 'not-a-model' },
      },
    };

    const put = await server.api('PUT', '/api/config', next);
    expect(put.status).toBe(400);
    expect(put.body).toMatchObject({ error: { code: 'validation' } });
    expect(put.body.error.message).toContain('defaultModel');

    const after = await server.api('GET', '/api/config');
    expect(after.body).toEqual(current);
  });

  it('pokes the Auto-Runner on success, same as PATCH', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'ping', state: 'ready' });

    const current = (await server.api('GET', '/api/config')).body;
    const next = { ...current, autoRunner: { ...current.autoRunner, enabled: true } };
    const put = await server.api('PUT', '/api/config', next);
    expect(put.status).toBe(200);

    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return task.state === 'working' || task.state === 'done';
    });
  });
});
