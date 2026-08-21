import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, stubHarness, waitFor, captureRunEnv, type TestServer } from './helpers.js';
import { workContextKey } from '../src/domain/work-context-key.js';

async function mcpClient(server: TestServer, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as any);
  return client;
}
const parse = (result: any) => JSON.parse(result.content[0].text);

/**
 * The operator supersede/unlock + queue-diagnostics surface over Work
 * Context leases (issue #125), over both REST and MCP.
 */
describe('Work Context lease operator surface (issue #125)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  /** Directly seed a `held` lease on a fresh Task's direct-mode context,
   * owned by a fresh Run — sidesteps orchestrating a real spawn, matching the
   * store-level fixture style other route tests use (`runKeyRows`, etc). */
  const seedLease = async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'lease target' });
    let task = await ctx().tasks.get(created.body.id);
    const run = await ctx().runs.create(task.id);
    const key = workContextKey({ isolationMode: 'direct', workingDir: task.workingDir });
    const lease = await ctx().leases.acquire(key, run.id, 'executing');
    // A Task genuinely occupying a context is `running` (Runner.beginRun flips
    // this before acquiring the lease) — matching that here keeps the Task
    // itself out of its own "waiting" count in the diagnostics view.
    task = await ctx().tasks.setState(task.id, 'running');
    return { task, run, key, lease };
  };
  const ctx = () => server.app.ctx;

  describe('GET /api/leases', () => {
    it('lists a held lease with its owner Run/Task resolved', async () => {
      const { task, run, key } = await seedLease();

      const res = await server.api('GET', '/api/leases');
      expect(res.status).toBe(200);
      expect(res.body.leases).toHaveLength(1);
      expect(res.body.leases[0]).toMatchObject({
        key,
        state: 'held',
        ownerRunId: run.id,
        ownerTaskId: task.id,
        ownerTaskTitle: task.prompt,
        waitingTaskCount: 0,
      });
    });

    it('reports a queued ready Task blocked on the same direct context, with a wait time from AutoRunner.waitingSince', async () => {
      const { task, key } = await seedLease();
      const waiter = await server.api('POST', '/api/tasks', { prompt: 'blocked', workingDir: task.workingDir });

      // Enabling Auto-Runner pokes it; the fill pass skips `waiter` (context
      // occupied, per the House Rule — #120) and starts its wait clock (#125).
      // Wait for the clock itself, not just `waitingTaskCount` (which is
      // derived from static Task rows and would already read 1 before any
      // pick pass has actually run). `seedLease`'s manually-created owner Run
      // row already counts as "running" against the Machine Ceiling — raise
      // it so the fill loop actually gets a turn to run `pickNext`.
      await server.api('PATCH', '/api/config', { autoRunner: { enabled: true, maxConcurrentRuns: 2 } });
      await waitFor(async () => ctx().autoRunner.waitingSince(waiter.body.id) !== undefined || undefined);

      const res = await server.api('GET', '/api/leases');
      expect(res.body.leases[0]).toMatchObject({ key, waitingTaskCount: 1 });
      expect(res.body.leases[0].longestWaitMs).toBeGreaterThanOrEqual(0);
    });

    it('returns an empty list when nothing is leased', async () => {
      const res = await server.api('GET', '/api/leases');
      expect(res.body).toEqual({ leases: [] });
    });
  });

  describe('POST /api/leases/supersede', () => {
    it('re-points the lease to the named Run and pokes the Auto-Runner', async () => {
      const { task, key } = await seedLease();
      const target = await ctx().runs.create(task.id);

      const res = await server.api('POST', '/api/leases/supersede', { key, runId: target.id });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      expect(await ctx().leases.getByKey(key)).toMatchObject({ ownerRunId: target.id, state: 'held' });
      const dispositions = await ctx().leases.listDispositions();
      expect(dispositions).toHaveLength(1);
      expect(dispositions[0]).toMatchObject({ key, action: 'supersede', targetRunId: target.id });
    });

    it('404s when the key holds no lease', async () => {
      const { task } = await seedLease();
      const target = await ctx().runs.create(task.id);
      const res = await server.api('POST', '/api/leases/supersede', { key: 'direct:/no/such/lease', runId: target.id });
      expect(res.status).toBe(404);
    });

    it('404s when the target Run does not exist, without touching the lease', async () => {
      const { key, run } = await seedLease();
      const res = await server.api('POST', '/api/leases/supersede', { key, runId: 999999 });
      expect(res.status).toBe(404);
      expect(await ctx().leases.getByKey(key)).toMatchObject({ ownerRunId: run.id });
    });
  });

  describe('POST /api/leases/unlock', () => {
    it('force-releases the lease, frees the key, and pokes the Auto-Runner', async () => {
      const { key } = await seedLease();

      const res = await server.api('POST', '/api/leases/unlock', { key });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      expect(await ctx().leases.getByKey(key)).toBeUndefined();
      const dispositions = await ctx().leases.listDispositions();
      expect(dispositions).toHaveLength(1);
      expect(dispositions[0]).toMatchObject({ key, action: 'unlock' });
    });

    it('404s when the key holds no lease', async () => {
      const res = await server.api('POST', '/api/leases/unlock', { key: 'direct:/no/such/lease' });
      expect(res.status).toBe(404);
    });
  });

  describe('operator-only gating', () => {
    it('denies a run-scoped Run Key on GET/POST /api/leases*', async () => {
      const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
      const token = env.HARMONIC_API_KEY as string;

      const asAgent = (method: string, path: string, body?: unknown) =>
        fetch(server.baseUrl + path, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

      expect((await asAgent('GET', '/api/leases')).status).toBe(403);
      expect((await asAgent('POST', '/api/leases/supersede', { key: 'x', runId: 1 })).status).toBe(403);
      expect((await asAgent('POST', '/api/leases/unlock', { key: 'x' })).status).toBe(403);
    });

    it('denies a read-scoped key on GET /api/leases', async () => {
      const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
      const res = await fetch(`${server.baseUrl}/api/leases`, { headers: { authorization: `Bearer ${body.token}` } });
      expect(res.status).toBe(403);
    });
  });
});

describe('Work Context lease MCP tools (issue #125)', () => {
  let server: TestServer;
  let operatorToken: string;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    const key = await server.api('POST', '/api/keys', { name: 'mcp-operator' });
    operatorToken = key.body.token;
  });
  afterAll(async () => {
    await server.close();
  });

  it('exposes list_leases/supersede_lease/unlock_lease to a full-scope operator key', async () => {
    const client = await mcpClient(server, operatorToken);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(['list_leases', 'supersede_lease', 'unlock_lease']),
    );

    const created = await server.api('POST', '/api/tasks', { prompt: 'mcp lease target' });
    const task = await server.app.ctx.tasks.get(created.body.id);
    const run = await server.app.ctx.runs.create(task.id);
    const realKey = workContextKey({ isolationMode: 'direct', workingDir: task.workingDir });
    await server.app.ctx.leases.acquire(realKey, run.id, 'executing');

    const listed = parse(await client.callTool({ name: 'list_leases', arguments: {} }));
    expect(listed.find((l: any) => l.key === realKey)).toMatchObject({ ownerRunId: run.id });

    const target = await server.app.ctx.runs.create(task.id);
    const superseded = parse(
      await client.callTool({ name: 'supersede_lease', arguments: { key: realKey, runId: target.id } }),
    );
    expect(superseded.ok).toBe(true);
    expect(await server.app.ctx.leases.getByKey(realKey)).toMatchObject({ ownerRunId: target.id });

    const unlocked = parse(await client.callTool({ name: 'unlock_lease', arguments: { key: realKey } }));
    expect(unlocked).toEqual({ ok: true });
    expect(await server.app.ctx.leases.getByKey(realKey)).toBeUndefined();

    await client.close();
  });

  it('rejects a run-scoped Run Key calling the lease tools with a forbidden domain error, even though /mcp itself admits it', async () => {
    const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
    const runToken = env.HARMONIC_API_KEY as string;

    const client = await mcpClient(server, runToken);
    // The agent surface still works — /mcp itself admits a Run Key.
    const list = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(list.isError).toBeFalsy();

    const forbidden = await client.callTool({ name: 'list_leases', arguments: {} });
    expect(forbidden.isError).toBe(true);
    expect((forbidden.content as any)[0].text).toContain('forbidden');

    const forbiddenUnlock = await client.callTool({ name: 'unlock_lease', arguments: { key: 'direct:/x' } });
    expect(forbiddenUnlock.isError).toBe(true);

    await client.close();
  });

  it('denies a read-scoped key the lease MCP tools too', async () => {
    const { body } = await server.api('POST', '/api/keys', { name: 'viz2', scope: 'read' });
    // A read-scoped key can't reach /mcp at all (scopedKeyAllowed only covers
    // 'run'-scope keys; readScopeAllowed gates GET-only REST) — assert the
    // connection itself is refused rather than assuming tool-level gating.
    await expect(mcpClient(server, body.token)).rejects.toThrow();
  });
});
