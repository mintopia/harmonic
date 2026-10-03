import { trackerRef } from '../src/tracker/adapter.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tasks, agentMessages, type TaskState } from '../src/db/schema.js';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

async function mcpClient(server: TestServer, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as any);
  return client;
}

const parse = (result: any) => JSON.parse(result.content[0].text);
const text = (result: any): string => result.content[0].text;
const EPIC = 400;

describe('agent messages over MCP', () => {
  let server: TestServer;
  let workspaceId: number;
  let a: { id: number; attemptId: number; client: Client };
  let b: { id: number; attemptId: number; client: Client };
  const ids: Record<string, number> = {};

  const setState = (id: number, state: TaskState, parent: number | null = EPIC) =>
    server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ state, trackerParent: parent === null ? null : trackerRef(parent) }).where(eq(tasks.id, id)).run());

  async function runToDone(prompt: string) {
    const created = await server.api('POST', '/api/tasks', { prompt });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const key = await server.app.ctx.auth.createKey(`am-${created.body.id}`, { scope: 'attempt', attemptId: started.body.id });
    return { id: created.body.id as number, attemptId: started.body.id as number, client: await mcpClient(server, key.token) };
  }

  beforeAll(async () => {
    server = await startServer(stubHarness());
    a = await runToDone('sender a');
    b = await runToDone('sender b');
    workspaceId = (await server.app.ctx.tasks.get(a.id)).workspaceId!;
    await server.app.ctx.workspaces.update(workspaceId, { agentMessagesEnabled: true, agentMessagesSendCap: 3 });
    for (const name of ['paused', 'ready', 'done', 'cancelled', 'draft']) {
      ids[name] = (await server.api('POST', '/api/tasks', { prompt: name, state: 'draft' })).body.id;
      await setState(ids[name]!, name as TaskState);
    }
    await setState(a.id, 'working');
    await setState(b.id, 'working');
  });
  afterAll(async () => {
    await a.client.close();
    await b.client.close();
    await server.close();
  });

  const messageCount = async () => (await server.app.ctx.asyncDb.read((d) => d.select().from(agentMessages).all())).length;

  it('lists peers: open siblings and the Epic address only', async () => {
    const peers = parse(await a.client.callTool({ name: 'list_peers', arguments: {} }));
    expect(peers.epic).toBe(`epic:${EPIC}`);
    expect(peers.peers.map((p: any) => p.taskId).sort()).toEqual([b.id, ids.paused, ids.ready].sort());
    expect(peers.peers.find((p: any) => p.taskId === ids.paused).state).toBe('paused');
  });

  it('refuses draft, done, cancelled, self and other-Workspace recipients without storing', async () => {
    const other = await server.app.ctx.workspaces.create({ name: 'other', workingDir: mkdtempSync(join(tmpdir(), 'am-other-')) } as any);
    const foreign = (await server.api('POST', '/api/tasks', { prompt: 'foreign', state: 'draft' })).body.id;
    await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ workspaceId: other.id, state: 'ready' }).where(eq(tasks.id, foreign)).run());
    const cases: [number, RegExp][] = [
      [ids.draft!, /draft/],
      [ids.done!, /done/],
      [ids.cancelled!, /cancelled/],
      [a.id, /yourself/],
      [foreign, /not in your Workspace/],
    ];
    for (const [to, reason] of cases) {
      const res = await a.client.callTool({ name: 'send_message', arguments: { to, text: 'hi' } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(reason);
    }
    expect(await messageCount()).toBe(0);
  });

  it('exchanges messages between two Attempt Keys, threads replies, and counts the cap per Attempt', async () => {
    const sent = parse(await a.client.callTool({ name: 'send_message', arguments: { to: b.id, text: 'ping' } }));
    expect(sent.recipients).toEqual([{ taskId: b.id, receipt: 'held' }]);

    const reply = parse(await b.client.callTool({ name: 'send_message', arguments: { to: a.id, text: 'pong', replyTo: sent.messageId } }));
    expect(reply.threadId).toBe(sent.messageId);

    const read = parse(await a.client.callTool({ name: 'read_messages', arguments: {} }));
    expect(read.map((m: any) => m.parts[0].text)).toEqual(['ping', 'pong']);
    expect(read[1]).toMatchObject({ replyTo: sent.messageId, threadId: sent.messageId, senderTaskId: b.id, senderAttemptId: b.attemptId, workspaceId, role: 'agent' });
    expect(parse(await b.client.callTool({ name: 'read_messages', arguments: {} })).length).toBe(2);

    const epic = parse(await a.client.callTool({ name: 'send_message', arguments: { to: `epic:${EPIC}`, text: 'all hands' } }));
    expect(epic.recipients.map((r: any) => r.taskId).sort()).toEqual([b.id, ids.paused, ids.ready].sort());

    expect(parse(await a.client.callTool({ name: 'send_message', arguments: { to: b.id, text: 'third' } })).sendsRemaining).toBe(0);
    const before = await messageCount();
    const capped = await a.client.callTool({ name: 'send_message', arguments: { to: b.id, text: 'fourth' } });
    expect(capped.isError).toBe(true);
    expect(text(capped)).toMatch(/cap of 3/);
    expect(await messageCount()).toBe(before);

    expect(parse(await b.client.callTool({ name: 'send_message', arguments: { to: a.id, text: 'still has budget' } })).sendsRemaining).toBe(1);
  });

  it('addresses a Jira-style Epic ref exactly as list_peers returned it', async () => {
    const c = await runToDone('jira sender');
    const d = await runToDone('jira peer');
    for (const t of [c, d]) {
      await server.app.ctx.asyncDb.write((db) => db.update(tasks).set({ state: 'working', trackerParent: trackerRef('ABC-1') }).where(eq(tasks.id, t.id)).run());
    }
    const peers = parse(await c.client.callTool({ name: 'list_peers', arguments: {} }));
    expect(peers.epic).toBe('epic:ABC-1');
    const sent = parse(await c.client.callTool({ name: 'send_message', arguments: { to: peers.epic, text: 'jira hello' } }));
    expect(sent.recipients.map((r: any) => r.taskId)).toEqual([d.id]);

    const wrong = await c.client.callTool({ name: 'send_message', arguments: { to: 'epic:abc-1', text: 'wrong case' } });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toMatch(/not your Epic/);
    await c.client.close();
    await d.client.close();
  });

  it('never stores more sends than the cap under concurrent send_message calls', async () => {
    const c = await runToDone('burst sender');
    const d = await runToDone('burst peer');
    for (const t of [c, d]) {
      await server.app.ctx.asyncDb.write((db) => db.update(tasks).set({ state: 'working', trackerParent: trackerRef('BURST-1') }).where(eq(tasks.id, t.id)).run());
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => c.client.callTool({ name: 'send_message', arguments: { to: d.id, text: `burst ${i}` } })),
    );
    expect(results.filter((r) => !r.isError)).toHaveLength(3);
    expect(results.filter((r) => r.isError).every((r) => /cap of 3/.test(text(r)))).toBe(true);
    const stored = await server.app.ctx.asyncDb.read((db) => db.select().from(agentMessages).where(eq(agentMessages.senderAttemptId, c.attemptId)).all());
    expect(stored).toHaveLength(3);
    await c.client.close();
    await d.client.close();
  });

  it('rejects a message longer than the text bound without storing it', async () => {
    const before = await messageCount();
    const res = await b.client.callTool({ name: 'send_message', arguments: { to: a.id, text: 'x'.repeat(4001) } }).catch((e) => e);
    expect(res instanceof Error || (res as any).isError).toBe(true);
    expect(await messageCount()).toBe(before);
    const tool = (await b.client.listTools()).tools.find((t) => t.name === 'send_message');
    expect(tool?.description).toMatch(/4000/);
  });

  it('offers no Agent Message tools to Conversation, Epic Attempt or full-scope callers', async () => {
    const names = (c: Client) => c.listTools().then((r) => r.tools.map((t) => t.name));
    await server.app.ctx.tasks.syncEpics(workspaceId, [{ ref: trackerRef(EPIC), kind: 'epic' }]);
    const epicAttempt = await server.app.ctx.attempts.createForEpic({ workspaceId, epicRef: trackerRef(EPIC) });
    const keys = [
      await server.app.ctx.auth.createKey('am-conversation', { scope: 'conversation' }),
      await server.app.ctx.auth.createKey('am-epic', { scope: 'attempt', attemptId: epicAttempt.id }),
      await server.app.ctx.auth.createKey('am-full-scope', { scope: 'full' }),
    ];
    for (const { token } of keys) {
      const client = await mcpClient(server, token);
      expect(await names(client)).not.toEqual(expect.arrayContaining(['send_message']));
      expect(await names(client)).not.toContain('read_messages');
      expect(await names(client)).not.toContain('list_peers');
      await client.close();
    }
  });

  it('offers the tools only to enabled Task Attempts', async () => {
    const names = (c: Client) => c.listTools().then((r) => r.tools.map((t) => t.name));
    expect(await names(a.client)).toEqual(expect.arrayContaining(['send_message', 'read_messages', 'list_peers']));

    const operator = await mcpClient(server, (await server.api('POST', '/api/keys', { name: 'am-full' })).body.token);
    expect(await names(operator)).not.toContain('send_message');
    await operator.close();

    await server.app.ctx.workspaces.update(workspaceId, { agentMessagesEnabled: false });
    const fresh = await mcpClient(server, (await server.app.ctx.auth.createKey('am-off', { scope: 'attempt', attemptId: a.attemptId })).token);
    expect(await names(fresh)).not.toContain('send_message');
    const call = await fresh.callTool({ name: 'send_message', arguments: { to: b.id, text: 'x' } }).catch((e) => e);
    expect(call instanceof Error || (call as any).isError).toBe(true);
    await fresh.close();
  });
});
