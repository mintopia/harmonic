import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

async function mcpClient(server: TestServer, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
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
    expect(queued.state).toBe('blocked');
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

  it('rejects unauthenticated and revoked-key MCP requests', async () => {
    await expect(mcpClient(server, 'adk_bogus')).rejects.toThrow();

    const key = await server.api('POST', '/api/keys', { name: 'short-lived' });
    const client = await mcpClient(server, key.body.token);
    parse(await client.callTool({ name: 'list_tasks', arguments: {} }));
    await client.close();

    await server.api('DELETE', `/api/keys/${key.body.id}`);
    await expect(mcpClient(server, key.body.token)).rejects.toThrow();
  });

  it('injects a Run Key and the MCP endpoint into the harness env, deleting the key after the run', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ echoEnv: ['AGENTDECK_API_KEY', 'AGENTDECK_MCP_URL'] }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');

    const events = await server.api('GET', `/api/runs/${started.body.id}/events`);
    const echo = events.body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
    const env = JSON.parse(echo.payload.content.text);
    expect(env.AGENTDECK_API_KEY).toMatch(/^adk_/);
    expect(env.AGENTDECK_MCP_URL).toContain('/mcp');

    // Run Keys are never listed, and the row is deleted once the run finished (issue 16).
    const keys = await server.api('GET', '/api/keys');
    expect(keys.body.keys.find((k: any) => k.runId === started.body.id)).toBeUndefined();
    const viaDeleted = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${env.AGENTDECK_API_KEY}` },
    });
    expect(viaDeleted.status).toBe(401);
  });

  it('hides accept/reject behind the agent-review flag (default off)', async () => {
    const client = await mcpClient(server, token);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('create_task');
    expect(tools).not.toContain('accept_task');
    expect(tools).not.toContain('reject_task');
    await client.close();

    await server.api('PATCH', '/api/config', { agentReview: true });
    const enabled = await mcpClient(server, token);
    const enabledTools = (await enabled.listTools()).tools.map((t) => t.name);
    expect(enabledTools).toContain('accept_task');
    expect(enabledTools).toContain('reject_task');

    // And they work: run something to awaiting-review, accept over MCP.
    const task = await server.api('POST', '/api/tasks', { prompt: 'review me' });
    await server.api('POST', `/api/tasks/${task.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${task.body.id}`)).body.state === 'awaiting-review');
    const accepted = parse(await enabled.callTool({ name: 'accept_task', arguments: { taskId: task.body.id } }));
    expect(accepted.state).toBe('completed');
    await enabled.close();

    await server.api('PATCH', '/api/config', { agentReview: false });
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
    expect(followUp.state).toBe('blocked');
    expect(followUp.dependsOn).toEqual([created.body.id]);

    // Accepting the parent unblocks the agent-scheduled follow-up.
    await server.api('POST', `/api/tasks/${created.body.id}/accept`);
    expect((await server.api('GET', `/api/tasks/${followUp.id}`)).body.state).toBe('ready');
  });
});
