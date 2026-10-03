import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tasks, agentMessages, type AgentMessageRecipient } from '../src/db/schema.js';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';

const EPIC = 500;
const parse = (result: any) => JSON.parse(result.content[0].text);

async function mcpClient(server: TestServer, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as any);
  return client;
}

describe('agent message delivery (stub Harness, run-control seam)', () => {
  let server: TestServer;
  let dataDir: string;
  const clients: Client[] = [];

  afterEach(async () => {
    delete process.env.STUB_NO_STEERING;
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    await server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  const inEpic = (id: number) =>
    server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ trackerParent: trackerRef(EPIC) }).where(eq(tasks.id, id)).run());

  async function boot(dir?: string) {
    dataDir = dir ?? mkdtempSync(join(tmpdir(), 'am-delivery-'));
    server = await startServer(stubHarness(), { dataDir });
  }

  async function sender() {
    const created = await server.api('POST', '/api/tasks', { prompt: 'sender' });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const workspaceId = (await server.app.ctx.tasks.get(created.body.id)).workspaceId!;
    await server.app.ctx.workspaces.update(workspaceId, { agentMessagesEnabled: true });
    await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ state: 'working', trackerParent: trackerRef(EPIC) }).where(eq(tasks.id, created.body.id)).run());
    const key = await server.app.ctx.auth.createKey(`am-${created.body.id}`, { scope: 'attempt', attemptId: started.body.id });
    const client = await mcpClient(server, key.token);
    clients.push(client);
    return { id: created.body.id as number, client };
  }

  async function liveRecipient() {
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ waitForSteer: true }) });
    const id = created.body.id as number;
    await inEpic(id);
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => ((server.app.ctx.runner as any).activeRuns.forTask(id)?.steerable ? true : undefined));
    return id;
  }

  async function readyRecipient() {
    const created = await server.api('POST', '/api/tasks', { prompt: 'held recipient' });
    await inEpic(created.body.id);
    return created.body.id as number;
  }

  const receiptOf = async (messageId: string, taskId: number): Promise<AgentMessageRecipient> => {
    const row = await server.app.ctx.agentMessages.get(messageId);
    return row!.recipients.find((r) => r.taskId === taskId)!;
  };

  const lifecycle = async (taskId: number, event: string) => {
    const attempts = await server.app.ctx.attempts.listForTask(taskId);
    const events = (await Promise.all(attempts.map((att) => server.app.ctx.attempts.listEvents(att.id)))).flat();
    return events.map((e) => e.payload as Record<string, unknown>).filter((p) => p?.event === event);
  };

  const lastPrompt = async (taskId: number): Promise<string> => {
    const attempts = await server.app.ctx.attempts.listForTask(taskId);
    return String(attempts[attempts.length - 1]?.prompt ?? '');
  };

  it('delivers mid-turn with the peer frame when the Harness supports steering', async () => {
    await boot();
    const b = await liveRecipient();
    const a = await sender();

    const sent = parse(await a.client.callTool({ name: 'send_message', arguments: { to: b, text: 'use the shared helper' } }));
    expect(sent.recipients).toEqual([{ taskId: b, receipt: 'delivered', mode: 'mid-turn', deliveredAt: expect.any(Number) }]);
    expect(await receiptOf(sent.messageId, b)).toMatchObject({ receipt: 'delivered', mode: 'mid-turn' });

    const injected = await waitFor(async () => {
      const found = await lifecycle(b, 'steer_injected');
      return found.length > 0 ? found : undefined;
    });
    expect(String(injected[0]!.text)).toBe(`Message from Task #${a.id} (Claude):\n\nuse the shared helper`);
    expect(String(injected[0]!.text)).not.toMatch(/operator/i);
  });

  it('queues, then delivers at the next turn, when the Harness cannot steer mid-turn', async () => {
    process.env.STUB_NO_STEERING = '1';
    await boot();
    const b = await liveRecipient();
    const a = await sender();

    const sent = parse(await a.client.callTool({ name: 'send_message', arguments: { to: b, text: 'next turn please' } }));
    expect(sent.recipients[0]).toMatchObject({ taskId: b, receipt: 'queued', mode: 'next-turn' });

    await waitFor(async () => ((await receiptOf(sent.messageId, b)).receipt === 'delivered' ? true : undefined));
    expect(await receiptOf(sent.messageId, b)).toMatchObject({ receipt: 'delivered', mode: 'next-turn', deliveredAt: expect.any(Number) });
    expect((await lifecycle(b, 'steer_delivered')).map((p) => String(p.text))).toContain(`Message from Task #${a.id} (Claude):\n\nnext turn please`);
  });

  it('holds for a recipient between Attempts and injects at its next Attempt, after a restart', async () => {
    await boot();
    const a = await sender();
    const c = await readyRecipient();

    const first = parse(await a.client.callTool({ name: 'send_message', arguments: { to: c, text: 'first note' } }));
    const second = parse(await a.client.callTool({ name: 'send_message', arguments: { to: c, text: 'second note' } }));
    expect(first.recipients).toEqual([{ taskId: c, receipt: 'held' }]);
    expect(await receiptOf(second.messageId, c)).toEqual({ taskId: c, receipt: 'held' });

    const dir = dataDir;
    await Promise.all(clients.splice(0).map((cl) => cl.close().catch(() => {})));
    await server.app.close();
    await boot(dir);

    expect(await receiptOf(first.messageId, c)).toEqual({ taskId: c, receipt: 'held' });
    await server.api('POST', `/api/tasks/${c}/run`);
    await waitFor(async () => ((await lastPrompt(c)).includes('Messages from peers') ? true : undefined));

    const prompt = await lastPrompt(c);
    expect(prompt.indexOf('first note')).toBeGreaterThan(prompt.indexOf('## Messages from peers'));
    expect(prompt.indexOf('second note')).toBeGreaterThan(prompt.indexOf('first note'));
    expect(prompt).toContain(`Message from Task #${a.id} (Claude)`);
    for (const id of [first.messageId, second.messageId]) {
      await waitFor(async () => ((await receiptOf(id, c)).receipt === 'delivered' ? true : undefined));
      expect(await receiptOf(id, c)).toMatchObject({ receipt: 'delivered', deliveredAt: expect.any(Number) });
    }
  });

  it('an Epic send reaches the live sibling and holds for the one between Attempts', async () => {
    await boot();
    const live = await liveRecipient();
    const idle = await readyRecipient();
    const a = await sender();

    const sent = parse(await a.client.callTool({ name: 'send_message', arguments: { to: `epic:${EPIC}`, text: 'all hands' } }));
    const byTask = new Map<number, AgentMessageRecipient>(sent.recipients.map((r: AgentMessageRecipient) => [r.taskId, r]));
    expect(byTask.get(live)).toMatchObject({ receipt: 'delivered', mode: 'mid-turn' });
    expect(byTask.get(idle)).toMatchObject({ receipt: 'held' });
  });

  it('puts the peer line in an enabled Workspace Attempt prompt and none in a disabled one', async () => {
    await boot();
    const workspaceId = (await server.app.ctx.tasks.get((await server.api('POST', '/api/tasks', { prompt: 'probe' })).body.id)).workspaceId!;

    await server.app.ctx.workspaces.update(workspaceId, { agentMessagesEnabled: false });
    const off = (await server.api('POST', '/api/tasks', { prompt: 'plain' })).body.id as number;
    await server.api('POST', `/api/tasks/${off}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${off}`)).body.state === 'done');
    expect(await lastPrompt(off)).not.toContain('send_message');

    await server.app.ctx.workspaces.update(workspaceId, { agentMessagesEnabled: true });
    const on = (await server.api('POST', '/api/tasks', { prompt: 'plain' })).body.id as number;
    await server.api('POST', `/api/tasks/${on}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${on}`)).body.state === 'done');
    expect(await lastPrompt(on)).toContain('send_message');
    expect(await server.app.ctx.asyncDb.read((d) => d.select().from(agentMessages).all())).toEqual([]);
  });

  it('leaves held messages held when the prompt never goes out', async () => {
    await boot();
    const a = await sender();
    const c = await readyRecipient();
    const sent = parse(await a.client.callTool({ name: 'send_message', arguments: { to: c, text: 'do not lose me' } }));

    let attempts = 0;
    (server.app.ctx.runner as any).turnDriver.completion.drivePromptCycle = async () => {
      attempts++;
      throw new Error('prompt send failed');
    };
    await server.api('POST', `/api/tasks/${c}/run`);
    await waitFor(async () => (attempts > 0 ? true : undefined));
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${c}`)).body.state !== 'working' ? true : undefined));

    expect(await receiptOf(sent.messageId, c)).toEqual({ taskId: c, receipt: 'held' });
  });

  it('leaves held messages untouched and adds no peer line once the Workspace has Agent Messages off', async () => {
    await boot();
    const a = await sender();
    const c = await readyRecipient();
    const sent = parse(await a.client.callTool({ name: 'send_message', arguments: { to: c, text: 'queued while on' } }));
    const workspaceId = (await server.app.ctx.tasks.get(c)).workspaceId!;
    await server.app.ctx.workspaces.update(workspaceId, { agentMessagesEnabled: false });

    await server.api('POST', `/api/tasks/${c}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${c}`)).body.state === 'done');

    const prompt = await lastPrompt(c);
    expect(prompt).not.toContain('Messages from peers');
    expect(prompt).not.toContain('queued while on');
    expect(prompt).not.toContain('send_message');
    expect(await receiptOf(sent.messageId, c)).toEqual({ taskId: c, receipt: 'held' });
  });

  it('holds, rather than steers, a message for a paused recipient', async () => {
    await boot();
    const b = await liveRecipient();
    const a = await sender();
    await server.api('POST', `/api/tasks/${b}/pause`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${b}`)).body.state === 'paused' ? true : undefined));

    const sent = parse(await a.client.callTool({ name: 'send_message', arguments: { to: b, text: 'while you are paused' } }));

    expect(sent.recipients).toEqual([{ taskId: b, receipt: 'held' }]);
    const mentionsMessage = (p: Record<string, unknown>) => String(p.text).includes('while you are paused');
    expect((await lifecycle(b, 'steer_injected')).filter(mentionsMessage)).toEqual([]);
    expect((await lifecycle(b, 'steer_queued')).filter(mentionsMessage)).toEqual([]);
  });
});
