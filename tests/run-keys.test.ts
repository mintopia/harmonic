import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { apiKeys } from '../src/db/schema.js';

/** All scope='run' key rows currently in the server's database. */
const runKeyRows = (server: TestServer) =>
  server.app.ctx.db.select().from(apiKeys).where(eq(apiKeys.scope, 'run')).all();

/** Start a run that echoes its injected Run Key, return the key + run info. */
async function startEchoRun(server: TestServer, exit: 'clean' | 'hang') {
  const created = await server.api('POST', '/api/tasks', {
    prompt: JSON.stringify({ echoEnv: ['AGENTDECK_API_KEY'], exit }),
  });
  const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
  const echo = await waitFor(async () => {
    const { body } = await server.api('GET', `/api/runs/${started.body.id}/events`);
    return body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
  });
  return {
    taskId: created.body.id as number,
    runId: started.body.id as number,
    token: JSON.parse(echo.payload.content.text).AGENTDECK_API_KEY as string,
  };
}

describe('run key lifecycle (issue 16)', () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  it('hard-deletes the run key when a run completes, and the token stops authenticating', async () => {
    server = await startServer(stubHarness());
    const { taskId, token } = await startEchoRun(server, 'clean');
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review',
    );

    expect(runKeyRows(server)).toEqual([]);
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('hard-deletes the run key when a run is cancelled', async () => {
    server = await startServer(stubHarness());
    const { taskId } = await startEchoRun(server, 'hang');
    expect(runKeyRows(server).length).toBe(1);

    await server.api('POST', `/api/tasks/${taskId}/cancel`);
    await waitFor(async () => runKeyRows(server).length === 0 || undefined);
  });

  it('hard-deletes the run key when a run fails', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ exit: 'crash-before-response' }),
    });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'failed',
    );
    expect(runKeyRows(server)).toEqual([]);
  });

  it('hard-deletes the run key when the harness fails to even spawn', async () => {
    server = await startServer(stubHarness());
    // An empty command makes spawn throw synchronously — after the key
    // was already minted.
    await server.api('PATCH', '/api/config', { harnesses: { claude: { command: '' } } });
    const created = await server.api('POST', '/api/tasks', { prompt: 'never runs' });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'failed',
    );
    expect(runKeyRows(server)).toEqual([]);
  });

  it('startup sweep deletes orphaned run keys, not operator keys', async () => {
    server = await startServer(stubHarness());
    // An orphan: a Run Key whose run does not exist / is not running.
    const orphan = server.app.ctx.auth.createKey('run-999', { scope: 'run', runId: 999 });
    const operator = await server.api('POST', '/api/keys', { name: 'ops' });

    const dataDir = server.dataDir;
    await server.app.close();
    server = await startServer(stubHarness(), { dataDir });

    expect(runKeyRows(server)).toEqual([]);
    const orphanRes = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${orphan.token}` },
    });
    expect(orphanRes.status).toBe(401);

    // The operator key survived the sweep and still authenticates.
    const opRes = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${operator.body.token}` },
    });
    expect(opRes.status).toBe(200);
  });

  it('never lists Run Keys, even while the run is active', async () => {
    server = await startServer(stubHarness());
    await server.api('POST', '/api/keys', { name: 'ops' });
    const { taskId } = await startEchoRun(server, 'hang');
    expect(runKeyRows(server).length).toBe(1); // the run key exists right now

    const { body } = await server.api('GET', '/api/keys');
    expect(body.keys.map((k: any) => k.name)).toEqual(['ops']);
    expect(body.keys.every((k: any) => k.scope === 'full')).toBe(true);

    await server.api('POST', `/api/tasks/${taskId}/cancel`);
  });
});
