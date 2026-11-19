import { describe, it, expect, afterEach, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { tasks, agentMessages, type AgentMessageRecipient, type AgentMessageRow } from '../src/db/schema.js';
import { startServer, stubHarness, waitFor, type TestServer, withArchivedPrompt, allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TaskService } from '../src/domain/tasks.js';
import { AgentMessageStore } from '../src/domain/agent-messages.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { deliverAgentMessage, type AgentMessageRunner } from '../src/execution/agent-message-delivery.js';

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
    return String((await withArchivedPrompt(server, attempts[attempts.length - 1]))?.prompt ?? '');
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

  it('uses edited peer Library prompts for the live frame and the held-message prompt', async () => {
    await boot();
    const b = await liveRecipient();
    const a = await sender();
    const c = await readyRecipient();
    const { promptLibrary } = server.app.ctx;
    await promptLibrary.create('peerLiveMessage-edited', 'live frame', 'LIVE from #{taskId} ({harness}) :: {text}');
    await promptLibrary.create('peerMessages-edited', 'inbox', 'INBOX\n{messages}');
    await promptLibrary.create('peerMessage-edited', 'entry', '* #{taskId}/{harness}: {text}');
    await promptLibrary.create('peerLine-edited', 'line', 'Peers can be reached.');

    await a.client.callTool({ name: 'send_message', arguments: { to: b, text: 'live note' } });
    const injected = await waitFor(async () => {
      const found = await lifecycle(b, 'steer_injected');
      return found.length > 0 ? found : undefined;
    });
    expect(String(injected[0]!.text)).toBe(`LIVE from #${a.id} (Claude) :: live note`);

    await a.client.callTool({ name: 'send_message', arguments: { to: c, text: 'held note' } });
    await server.api('POST', `/api/tasks/${c}/run`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${c}`)).body.state === 'done' ? true : undefined));
    const prompt = await lastPrompt(c);
    expect(prompt).toContain(`INBOX\n* #${a.id}/Claude: held note\n\nPeers can be reached.`);
    expect(prompt).not.toContain('## Messages from peers');
    expect(prompt).not.toContain('send_message');
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

describe('Agent Message deletion rules (#763)', () => {
  let dataDir: string;
  let asyncDb: AsyncDbHandle;
  let workspaces: WorkspaceService;
  let tasks: TaskService;
  let store: AgentMessageStore;
  let workspaceId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-am-del-'));
    asyncDb = await openAsyncDb(dataDir);
    workspaceId = await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dataDir);
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    store = new AgentMessageStore(asyncDb);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const send = (senderTaskId: number, recipientIds: number[], threadId: string | null = null) =>
    store.create({
      workspaceId,
      text: 'hello',
      replyTo: null,
      threadId,
      senderTaskId,
      senderAttemptId: 1,
      recipients: recipientIds.map((taskId) => ({ taskId, receipt: 'queued' as const })),
    });

  it('deletes a Workspace together with its Agent Messages', async () => {
    const a = await tasks.create({ prompt: 'a' });
    const b = await tasks.create({ prompt: 'b' });
    await send(a.id, [b.id]);
    expect(await asyncDb.read((d) => d.select().from(agentMessages).all())).toHaveLength(1);

    await workspaces.delete(workspaceId);

    expect(await asyncDb.read((d) => d.select().from(agentMessages).all())).toHaveLength(0);
  });

  it('keeps the Thread when a participant Task is deleted and marks that side deleted', async () => {
    const a = await tasks.create({ prompt: 'a' });
    const b = await tasks.create({ prompt: 'b' });
    const root = await send(a.id, [b.id]);
    await send(b.id, [a.id], root.threadId);

    await tasks.delete(b.id);

    const seen = await store.presentedForTask(workspaceId, a.id);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ senderTaskId: a.id, senderDeleted: false, recipients: [{ taskId: b.id, deleted: true }] });
    expect(seen[1]).toMatchObject({ senderTaskId: b.id, senderDeleted: true, recipients: [{ taskId: a.id, deleted: false }] });
    expect(new Set(seen.map((m) => m.threadId))).toEqual(new Set([root.threadId]));
  });
});

const DEFAULT_PROMPTS = bundledEnginePrompts();

describe('deliverAgentMessage — a next-turn steer dropped when the run ends', () => {
  it('returns the queued receipt to held so it is redelivered later', async () => {
    const receipts: Partial<AgentMessageRecipient>[] = [];
    const store = { updateRecipient: vi.fn(async (_m: string, _t: number, patch: Partial<AgentMessageRecipient>) => void receipts.push(patch)) };
    let drop: (() => void) | undefined;
    const pending: Array<Promise<unknown>> = [];
    const runner: AgentMessageRunner = {
      hasLiveAgent: () => true,
      trackBackground: (op) => void pending.push(op()),
      runControl: {
        steerWithMode: async (_t, _text, _onDelivered, onDropped) => {
          drop = onDropped;
          return 'next-turn';
        },
      },
    };
    const row = { id: 'm1', senderTaskId: 1, recipients: [{ taskId: 2, receipt: 'held' }], parts: [{ text: 'hi' }] } as unknown as AgentMessageRow;

    await deliverAgentMessage({ store: store as unknown as AgentMessageStore, runner, prompts: { ...DEFAULT_PROMPTS } }, row, { id: 1, harness: 'claude' });
    expect(receipts.at(-1)).toMatchObject({ receipt: 'queued' });

    drop!();
    await Promise.all(pending);
    expect(receipts.at(-1)).toMatchObject({ receipt: 'held' });
  });
});

describe('Agent Messages on the Task timeline API', () => {
  let server: TestServer;
  let sender: number;
  let recipient: number;
  let attemptId: number;
  let workspaceId: number;

  const agentRows = async (taskId: number) => {
    const { body } = await server.api('GET', `/api/tasks/${taskId}/timeline`);
    return body.events.filter((e: any) => e.kind === 'agent-message').map((e: any) => e.data);
  };

  beforeAll(async () => {
    server = await startServer(stubHarness());
    sender = (await server.api('POST', '/api/tasks', { prompt: 'sender' })).body.id;
    recipient = (await server.api('POST', '/api/tasks', { prompt: 'recipient' })).body.id;
    attemptId = (await server.api('POST', `/api/tasks/${sender}/run`)).body.id;
    workspaceId = (await server.app.ctx.tasks.get(sender)).workspaceId!;
    const send = (text: string, recipients: any[], replyTo: string | null = null, threadId: string | null = null) =>
      server.app.ctx.agentMessages.create({ workspaceId, text, replyTo, threadId, senderTaskId: sender, senderAttemptId: attemptId, recipients });
    const root = await send('hello', [{ taskId: recipient, receipt: 'held' }]);
    await send('again', [{ taskId: recipient, receipt: 'delivered', deliveredAt: 1 }], root.id, root.threadId);
    await send('nope', [{ taskId: recipient, receipt: 'refused', reason: 'recipient is done' }]);
  });
  afterAll(async () => { await server.close(); });

  it('emits a sent row per recipient on the sender, carrying receipt, preview and Thread id, including the refusal', async () => {
    const rows = await agentRows(sender);
    expect(rows.map((r: any) => [r.direction, r.receipt, r.preview, r.peerTaskId, r.isReply])).toEqual([
      ['sent', 'held', 'hello', recipient, false],
      ['sent', 'delivered', 'again', recipient, true],
      ['sent', 'refused', 'nope', recipient, false],
    ]);
    expect(rows.map((r: any) => r.sendNumber)).toEqual([1, 2, 3]);
    expect(rows[1].threadId).toBe(rows[0].threadId);
    expect(rows[2].reason).toBe('recipient is done');
  });

  it('emits received rows on the recipient but hides the refused send', async () => {
    const rows = await agentRows(recipient);
    expect(rows.map((r: any) => [r.direction, r.receipt, r.preview, r.peerTaskId])).toEqual([
      ['received', 'held', 'hello', sender],
      ['received', 'delivered', 'again', sender],
    ]);
  });
});

describe('agent_messages_changed notification', () => {
  let dataDir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let store: AgentMessageStore;
  let workspaceId: number;
  const changed: number[] = [];

  beforeEach(async () => {
    changed.length = 0;
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-am-evt-'));
    asyncDb = await openAsyncDb(dataDir);
    workspaceId = await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dataDir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    store = new AgentMessageStore(asyncDb, (id) => changed.push(id));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('fires when a message is created and when a receipt changes', async () => {
    const a = await tasks.create({ prompt: 'a' });
    const b = await tasks.create({ prompt: 'b' });
    const row = await store.create({
      workspaceId,
      text: 'hi',
      replyTo: null,
      threadId: null,
      senderTaskId: a.id,
      senderAttemptId: 1,
      recipients: [{ taskId: b.id, receipt: 'queued' }],
    });
    expect(changed).toEqual([workspaceId]);

    await store.updateRecipient(row.id, b.id, { receipt: 'held' });
    expect(changed).toEqual([workspaceId, workspaceId]);

    await store.markDelivered(await store.listHeld(b.id), b.id);
    expect(changed).toHaveLength(3);

    await store.updateRecipient('missing', b.id, { receipt: 'held' });
    expect(changed).toHaveLength(3);
  });
});

describe('agent message recipient index', () => {
  let server: TestServer;
  let dataDir = '';

  afterEach(async () => {
    await server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  async function boot() {
    dataDir ||= mkdtempSync(join(tmpdir(), 'am-index-'));
    server = await startServer(stubHarness(), { dataDir });
  }

  async function seed(recipients: AgentMessageRecipient[]) {
    const created = await server.api('POST', '/api/tasks', { prompt: 'sender' });
    const task = await server.app.ctx.tasks.get(created.body.id);
    const started = await server.api('POST', `/api/tasks/${task.id}/run`);
    const row = await server.app.ctx.agentMessages.create({
      workspaceId: task.workspaceId!,
      text: 'hello',
      replyTo: null,
      threadId: null,
      senderTaskId: task.id,
      senderAttemptId: started.body.id,
      recipients,
    });
    return { row, workspaceId: task.workspaceId! };
  }

  const plan = async (query: ReturnType<typeof sql>) =>
    (await server.app.ctx.asyncDb.read((d) => d.all<{ detail: string }>(query))).map((r) => r.detail).join('\n');

  it('searches the recipient index instead of scanning agent_messages JSON', async () => {
    await boot();
    const detail = await plan(
      sql`explain query plan select * from agent_messages where id in (select message_id from agent_message_recipients where task_id = 7 and receipt = 'held')`,
    );
    expect(detail).toMatch(/SEARCH .*agent_message_recipients.* USING (COVERING )?INDEX/);
    expect(detail).not.toMatch(/json_each/);
  });

  it('keeps the index in step with receipt changes', async () => {
    await boot();
    const { row } = await seed([{ taskId: 9001, receipt: 'held' }]);
    const store = server.app.ctx.agentMessages;
    expect((await store.listHeld(9001)).map((m) => m.id)).toEqual([row.id]);
    await store.markDelivered([row], 9001);
    expect(await store.listHeld(9001)).toEqual([]);
    await store.updateRecipient(row.id, 9001, { receipt: 'held' });
    expect((await store.listHeld(9001)).map((m) => m.id)).toEqual([row.id]);
  });

  it('backfills the index for messages stored before it existed', async () => {
    await boot();
    const { row } = await seed([{ taskId: 9002, receipt: 'held' }]);
    await server.app.ctx.asyncDb.write((d) => d.run(sql`delete from agent_message_recipients`));
    await server.app.close();
    await boot();
    expect((await server.app.ctx.agentMessages.listHeld(9002)).map((m) => m.id)).toEqual([row.id]);
  });
});
