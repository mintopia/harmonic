import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

async function mcpClient(
  server: TestServer,
  token: string,
  opts: { headers?: Record<string, string>; queryToken?: string } = {},
): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const url = new URL(`${server.baseUrl}/mcp`);
  if (opts.queryToken) url.searchParams.set('token', opts.queryToken);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...opts.headers } },
  });
  // as any: SDK transport types vs exactOptionalPropertyTypes.
  await client.connect(transport as any);
  return client;
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('mcp server & scoped keys', () => {
  let server: TestServer;
  let token: string;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    const key = await server.api('POST', '/api/keys', { name: 'mcp-test' });
    token = key.body.token;
  });
  afterAll(async () => {
    await server.close();
  });

  it('drives the full task lifecycle over MCP with a valid key', async () => {
    const client = await mcpClient(server, token);

    const created = parse(
      await client.callTool({
        name: 'create_task',
        arguments: { prompt: 'from mcp', state: 'draft', priority: 'high' },
      }),
    );
    expect(created.state).toBe('draft');

    const updated = parse(
      await client.callTool({ name: 'update_task', arguments: { taskId: created.id, model: 'my-model' } }),
    );
    expect(updated.model).toBe('my-model');

    const dep = parse(await client.callTool({ name: 'create_task', arguments: { prompt: 'dep' } }));
    parse(await client.callTool({ name: 'add_dependency', arguments: { taskId: created.id, dependsOnId: dep.id } }));
    const queued = parse(await client.callTool({ name: 'queue_task', arguments: { taskId: created.id } }));
    expect(queued.state).toBe('ready');
    expect(queued.openBlockerCount).toBe(1);
    expect(queued.agentWorkable).toBe(false);
    expect(queued.dependsOn).toEqual([dep.id]);

    parse(await client.callTool({ name: 'remove_dependency', arguments: { taskId: created.id, dependsOnId: dep.id } }));
    const list = parse(await client.callTool({ name: 'list_tasks', arguments: { state: 'ready' } }));
    expect(list.map((t: any) => t.id)).toContain(created.id);

    const cancelled = parse(await client.callTool({ name: 'cancel_task', arguments: { taskId: created.id } }));
    expect(cancelled.state).toBe('cancelled');

    // Run the dep for real and read runs + events over MCP.
    await server.api('POST', `/api/tasks/${dep.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${dep.id}`)).body.state === 'awaiting-review');
    const runs = parse(await client.callTool({ name: 'get_runs', arguments: { taskId: dep.id } }));
    expect(runs).toHaveLength(1);
    const events = parse(await client.callTool({ name: 'get_run_events', arguments: { runId: runs[0].id } }));
    expect(events.length).toBeGreaterThan(0);

    await client.close();
  });

  it('deletes a task over MCP, tearing down its record (issue #162)', async () => {
    const client = await mcpClient(server, token);

    const created = parse(await client.callTool({ name: 'create_task', arguments: { prompt: 'delete me over mcp' } }));

    const deleted = parse(await client.callTool({ name: 'delete_task', arguments: { taskId: created.id } }));
    expect(deleted).toEqual({ deleted: created.id });

    const gone = await client.callTool({ name: 'get_task', arguments: { taskId: created.id } });
    expect((gone as any).isError).toBe(true);

    await client.close();
  });

  it('rejects unauthenticated and revoked-key MCP requests', async () => {
    await expect(mcpClient(server, 'adk_bogus')).rejects.toThrow();

    const key = await server.api('POST', '/api/keys', { name: 'short-lived' });
    const client = await mcpClient(server, key.body.token);
    parse(await client.callTool({ name: 'list_tasks', arguments: {} }));
    await client.close();

    await server.api('DELETE', `/api/keys/${key.body.id}`);
    await expect(mcpClient(server, key.body.token)).rejects.toThrow();
  });

  it('falls back to the operator cookie credential when the Bearer is not an operator key (#276)', async () => {
    // The cookie is the surviving fallback: #273 restricted query-token auth to
    // websockets (a `?token=` in a URL leaks via logs/referrer), so a query
    // token no longer authenticates `/mcp` — only the session cookie does.
    const runKey = await server.app.ctx.auth.createKey('run-1', { scope: 'run', runId: 1 });
    const readKey = await server.app.ctx.auth.createKey('read-1', { scope: 'read' });

    for (const bearer of ['adk_bogus', runKey.token, readKey.token, token]) {
      const cookieClient = await mcpClient(server, bearer, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
      const cookieResult = await cookieClient.callTool({ name: 'list_leases', arguments: {} });
      expect(cookieResult.isError).not.toBe(true);
      await cookieClient.close();
    }
  });

  it('does not accept a query-token credential on /mcp — query tokens are websocket-only (#273)', async () => {
    // Even a valid operator token in the query string must not authenticate an
    // /mcp call that carries no other operator credential.
    await expect(mcpClient(server, 'adk_bogus', { queryToken: token })).rejects.toThrow();
  });

  it('injects a Run Key and the MCP endpoint into the harness env, deleting the key after the run', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY', 'HARMONIC_MCP_URL'] }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');

    // Run Keys are never listed, and the row is deleted once the run finished (issue 16).
    const keys = await server.api('GET', '/api/keys');
    expect(keys.body.keys.find((k: any) => k.runId === started.body.id)).toBeUndefined();
  });

  it('codex: registers the MCP server via session/new mcpServers with the Run Key as bearer (zero setup)', async () => {
    // Spike (issue 22): codex-acp honors HTTP mcpServers with headers; env
    // vars alone are not enough since nothing tells Codex to read them.
    const codexServer = await startServer(stubHarness('codex'));
    try {
      const created = await codexServer.api('POST', '/api/tasks', {
        harness: 'codex',
        prompt: JSON.stringify({ echoSessionNew: true, echoEnv: ['HARMONIC_API_KEY'] }),
      });
      const started = await codexServer.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await codexServer.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review',
      );

      const events = await codexServer.api('GET', `/api/runs/${started.body.id}/events`);
      expect(events.body.events.filter((event: any) => event.type === 'session_update')).toEqual([]);
    } finally {
      await codexServer.close();
    }
  });

  it('exposes finish_task / escalate_task; acknowledges with running:false when the Task is not executing', async () => {
    const client = await mcpClient(server, token);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('finish_task'); // always available — a completion signal, not a merge gate
    expect(tools).toContain('escalate_task');

    const draft = parse(await client.callTool({ name: 'create_task', arguments: { prompt: 'idle', state: 'draft' } }));
    expect(parse(await client.callTool({ name: 'finish_task', arguments: { taskId: draft.id } }))).toEqual({
      acknowledged: true,
      running: false,
    });
    expect(
      parse(await client.callTool({ name: 'escalate_task', arguments: { taskId: draft.id, reason: 'need input' } })),
    ).toEqual({ acknowledged: true, running: false });

    // A bad id is a domain error, not a silent ack.
    const bad = await client.callTool({ name: 'finish_task', arguments: { taskId: 999999 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('never exposes accept/reject over MCP (#140, ADR-0021: retired agentReview flag)', async () => {
    const client = await mcpClient(server, token);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('create_task');
    expect(tools).not.toContain('accept_task');
    expect(tools).not.toContain('reject_task');
    await client.close();

    // A legacy PATCH still carrying the retired flag is migrated (folded into
    // verify.autoAccept) rather than re-exposing the MCP tools.
    await server.api('PATCH', '/api/config', { agentReview: true });
    const stillHidden = await mcpClient(server, token);
    const stillHiddenTools = (await stillHidden.listTools()).tools.map((t) => t.name);
    expect(stillHiddenTools).not.toContain('accept_task');
    expect(stillHiddenTools).not.toContain('reject_task');
    await stillHidden.close();

    const config = (await server.api('GET', '/api/config')).body;
    expect(config.verify.autoAccept).toBe(true);
    expect(config.agentReview).toBeUndefined();
  });

  it('end-to-end: a run schedules a dependent follow-up task through its injected key', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'placeholder', state: 'draft' });
    await server.api('PATCH', `/api/tasks/${created.body.id}`, {
      prompt: JSON.stringify({
        mcpCreateTask: { prompt: 'follow-up work', dependsOn: [created.body.id] },
      }),
    });
    await server.api('POST', `/api/tasks/${created.body.id}/ready`);
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');

    const all = await server.api('GET', '/api/tasks');
    const followUp = all.body.tasks.find((t: any) => t.prompt === 'follow-up work');
    expect(followUp).toBeDefined();
    expect(followUp.state).toBe('ready');
    expect(followUp.openBlockerCount).toBe(1);
    expect(followUp.agentWorkable).toBe(false);
    expect(followUp.dependsOn).toEqual([created.body.id]);

    // Accepting the parent unblocks the agent-scheduled follow-up.
    await server.api('POST', `/api/tasks/${created.body.id}/accept`);
    expect((await server.api('GET', `/api/tasks/${followUp.id}`)).body.state).toBe('ready');
  });
});
