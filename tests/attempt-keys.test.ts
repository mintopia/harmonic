import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, captureRunEnv, type TestServer } from './helpers.js';
import { apiKeys } from '../src/db/schema.js';

const attemptKeyRows = (server: TestServer) =>
  server.app.ctx.asyncDb.read((d) => d.select().from(apiKeys).where(eq(apiKeys.scope, 'attempt')).all());

async function startEchoRun(server: TestServer, exit: 'clean' | 'hang') {
  const { taskId, attemptId, env } = await captureRunEnv(server, ['HARMONIC_API_KEY'], { exit });
  return { taskId, attemptId, token: env.HARMONIC_API_KEY as string };
}

describe('attempt key lifecycle (issue 16)', () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  it('hard-deletes the run key when a run completes, and the token stops authenticating', async () => {
    server = await startServer(stubHarness());
    const { taskId, token } = await startEchoRun(server, 'clean');
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done',
    );

    expect(await attemptKeyRows(server)).toEqual([]);
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('hard-deletes the run key when a run is cancelled', async () => {
    server = await startServer(stubHarness());
    const { taskId } = await startEchoRun(server, 'hang');
    expect((await attemptKeyRows(server)).length).toBe(1);

    await server.api('POST', `/api/tasks/${taskId}/cancel`);
    await waitFor(async () => (await attemptKeyRows(server)).length === 0 || undefined);
  });

  it('hard-deletes the run key when a run escalates', async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1 });
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ exit: 'crash-before-response' }),
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated',
    );
    expect(await attemptKeyRows(server)).toEqual([]);
  });

  it('hard-deletes the run key when the harness fails to even spawn', async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1 });
    await server.api('PATCH', '/api/config', { harnesses: { claude: { command: '' } } });
    const created = await server.api('POST', '/api/tasks', { prompt: 'never runs' });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated',
    );
    expect(await attemptKeyRows(server)).toEqual([]);
  });

  it('startup sweep deletes orphaned run keys, not operator keys', async () => {
    server = await startServer(stubHarness());
    const orphan = await server.app.ctx.auth.createKey('run-999', { scope: 'attempt', attemptId: 999 });
    const operator = await server.api('POST', '/api/keys', { name: 'ops' });

    const dataDir = server.dataDir;
    await server.app.close();
    server = await startServer(stubHarness(), { dataDir });

    expect(await attemptKeyRows(server)).toEqual([]);
    const orphanRes = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${orphan.token}` },
    });
    expect(orphanRes.status).toBe(401);

    const opRes = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${operator.body.token}` },
    });
    expect(opRes.status).toBe(200);
  });

  it('never lists Attempt Keys, even while the run is active', async () => {
    server = await startServer(stubHarness());
    await server.api('POST', '/api/keys', { name: 'ops' });
    const { taskId } = await startEchoRun(server, 'hang');
    expect((await attemptKeyRows(server)).length).toBe(1);

    const { body } = await server.api('GET', '/api/keys');
    expect(body.keys.map((k: any) => k.name)).toEqual(['ops']);
    expect(body.keys.every((k: any) => k.scope === 'full')).toBe(true);

    await server.api('POST', `/api/tasks/${taskId}/cancel`);
  });
});
