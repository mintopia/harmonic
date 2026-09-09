import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppConfig, type DeepPartial } from '../src/config.js';
import { apiKeys, conversationEvents } from '../src/db/schema.js';
import { accumulateUsage, type AttemptUsage, contextInputTokens } from '../src/execution/usage.js';
import { startServer, stubHarness, type TestServer, waitFor, connectFirehose } from './helpers.js';
import { eq } from 'drizzle-orm';
import { tmpdir } from 'node:os';

describe('conversation-chat-defaults', () => {
  const twoHarnessConfig: DeepPartial<AppConfig> = {
    harnesses: {
      claude: {
        command: 'noop',
        args: [],
        models: [{ id: 'claude-a' }, { id: 'claude-b' }],
        defaultModel: 'claude-a',
        cacheWarmSeconds: 300,
      },
      codex: {
        command: 'noop',
        args: [],
        models: [{ id: 'codex-a' }, { id: 'codex-b' }],
        defaultModel: 'codex-a',
        cacheWarmSeconds: 300,
      },
    },
    defaults: { harness: 'claude' },
    chat: { harness: 'codex', model: 'codex-b' },
  };

  describe('Conversation chat defaults (ADR-0012)', () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startServer(twoHarnessConfig);
    });
    afterEach(async () => {
      await server.close();
    });

    it('a new Conversation uses the global chat default, not the Task default', async () => {
      const { status, body } = await server.api('POST', '/api/conversations', {});
      expect(status).toBe(201);
      expect(body.harness).toBe('codex');
      expect(body.model).toBe('codex-b');
    });

    it("a Workspace's chat override wins over the global chat default", async () => {
      const ws = await server.app.ctx.workspaces.resolve();
      await server.app.ctx.workspaces.update(ws.id, { chatHarness: 'claude', chatModel: 'claude-b' });

      const { body } = await server.api('POST', '/api/conversations', {});
      expect(body.harness).toBe('claude');
      expect(body.model).toBe('claude-b');
    });

    it('an explicit request harness/model wins over both', async () => {
      const ws = await server.app.ctx.workspaces.resolve();
      await server.app.ctx.workspaces.update(ws.id, { chatHarness: 'claude', chatModel: 'claude-b' });

      const { body } = await server.api('POST', '/api/conversations', { harness: 'codex', model: 'codex-a' });
      expect(body.harness).toBe('codex');
      expect(body.model).toBe('codex-a');
    });

    it('rejects when the resolved chat harness is not configured on this instance', async () => {
      const ws = await server.app.ctx.workspaces.resolve();
      await server.app.ctx.workspaces.update(ws.id, { chatHarness: 'ghost' });

      const { status } = await server.api('POST', '/api/conversations', {});
      expect(status).toBe(400);
    });
  });
});

describe('conversation-steering', () => {
  async function events(server: TestServer, id: number): Promise<any[]> {
    return (await server.api('GET', `/api/conversations/${id}/events`)).body.events;
  }
  const userTurns = (evs: any[]) => evs.filter((e) => e.type === 'user_turn');
  const finishedEvents = (evs: any[]) => evs.filter((e) => e.type === 'lifecycle' && e.payload.event === 'finished');

  const slowTurn = (n: number, delayMs: number, marker: string) =>
    JSON.stringify({
      updates: Array.from({ length: n }, () => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: marker } })),
      delayMs,
    });

  describe('conversation steering — queue and interrupt (issue 14)', () => {
    let server: TestServer;
    beforeAll(async () => {
      server = await startServer(stubHarness());
    });
    afterAll(async () => {
      await server.close();
    });

    it('queues a message typed during a running Turn and sends it as the next Turn', async () => {
      const { body: convo } = await server.api('POST', '/api/conversations', {});
      const first = await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(6, 40, 'a') });
      expect(first.body).toEqual({ ok: true, queued: false });

      const second = await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(1, 5, 'b') });
      expect(second.body).toEqual({ ok: true, queued: true });

      await waitFor(async () => (finishedEvents(await events(server, convo.id)).length === 2 ? true : undefined));
      const evs = await events(server, convo.id);
      const turns = userTurns(evs);
      expect(turns).toHaveLength(2);
      const firstFinished = finishedEvents(evs)[0];
      expect(turns[1].seq).toBeGreaterThan(firstFinished.seq);
    });

    it('interrupts a running Turn and re-prompts with the steering message', async () => {
      const { body: convo } = await server.api('POST', '/api/conversations', {});
      await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(20, 30, 'x') });
      const res = await server.api('POST', `/api/conversations/${convo.id}/interrupt`, {
        text: slowTurn(1, 5, 'steered'),
      });
      expect(res.status).toBe(200);

      const cancelled = await waitFor(async () =>
        (await events(server, convo.id)).find((e) => e.type === 'lifecycle' && e.payload.stopReason === 'cancelled'),
      );
      expect(cancelled.payload.event).toBe('finished');
      await waitFor(async () => (userTurns(await events(server, convo.id)).length === 2 ? true : undefined));
      const evs = await events(server, convo.id);
      expect(userTurns(evs)[1].payload.text).toContain('steered');
      expect(userTurns(evs)[1].seq).toBeGreaterThan(cancelled.seq);
    });

    it('interrupt with an empty composer just stops the Turn — no new Turn', async () => {
      const { body: convo } = await server.api('POST', '/api/conversations', {});
      await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(20, 30, 'y') });
      const res = await server.api('POST', `/api/conversations/${convo.id}/interrupt`, {});
      expect(res.status).toBe(200);

      const cancelled = await waitFor(async () =>
        (await events(server, convo.id)).find((e) => e.type === 'lifecycle' && e.payload.stopReason === 'cancelled'),
      );
      expect(cancelled).toBeTruthy();
      expect(userTurns(await events(server, convo.id))).toHaveLength(1);
      expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(true);
    });
  });
});

describe('conversation-lifecycle', () => {
  async function firstTurn(server: TestServer, text: string) {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text });
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/conversations/${convo.id}/events`);
      return (body.events as any[]).some((e) => e.type === 'lifecycle' && e.payload.event === 'finished') || undefined;
    });
    return convo;
  }

  describe('conversation history & lifecycle (issue 15)', () => {
    let server: TestServer;
    afterEach(async () => {
      await server?.close();
    });

    it('auto-titles from the first Turn and honors an operator rename', async () => {
      server = await startServer(stubHarness());
      const convo = await firstTurn(server, 'Refactor the ACP connection handling');

      let got = (await server.api('GET', `/api/conversations/${convo.id}`)).body;
      expect(got.title).toBe('Refactor the ACP connection handling');

      const renamed = await server.api('PATCH', `/api/conversations/${convo.id}`, { title: 'Parser work' });
      expect(renamed.body.title).toBe('Parser work');

      const cleared = await server.api('PATCH', `/api/conversations/${convo.id}`, { title: null });
      expect(cleared.body.title).toBe('Refactor the ACP connection handling');
    });

    it('lists active and ended Conversations newest-first', async () => {
      server = await startServer(stubHarness());
      const a = await firstTurn(server, 'first');
      const b = await firstTurn(server, 'second');
      await server.api('POST', `/api/conversations/${b.id}/end`);

      const { body } = await server.api('GET', '/api/conversations');
      const ids = (body.conversations as any[]).map((c) => c.id);
      expect(ids.slice(0, 2)).toEqual([b.id, a.id]);
      expect((body.conversations as any[]).find((c) => c.id === b.id).state).toBe('ended');
    });

    it('deletes a Conversation, cascading its events and revoking its key', async () => {
      server = await startServer(stubHarness());
      const convo = await firstTurn(server, 'to be deleted');
      expect((await server.app.ctx.asyncDb.read((d) => d.select().from(conversationEvents).where(eq(conversationEvents.conversationId, convo.id)).all())).length).toBeGreaterThan(0);
      expect((await server.app.ctx.asyncDb.read((d) => d.select().from(apiKeys).where(eq(apiKeys.scope, 'conversation')).all())).length).toBe(1);

      const del = await server.api('DELETE', `/api/conversations/${convo.id}`);
      expect(del.status).toBe(200);

      expect((await server.api('GET', `/api/conversations/${convo.id}`)).status).toBe(404);
      expect(await server.app.ctx.asyncDb.read((d) => d.select().from(conversationEvents).where(eq(conversationEvents.conversationId, convo.id)).all())).toEqual([]);
      expect(await server.app.ctx.asyncDb.read((d) => d.select().from(apiKeys).where(eq(apiKeys.scope, 'conversation')).all())).toEqual([]);
    });

    it('ends a Conversation left idle past the timeout', async () => {
      server = await startServer({ ...stubHarness(), conversationIdleTimeoutMinutes: 0.03 });
      const convo = await firstTurn(server, 'idle me out');
      expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(true);

      await waitFor(
        async () => ((await server.api('GET', `/api/conversations/${convo.id}`)).body.state === 'ended' ? true : undefined),
        { timeoutMs: 6000 },
      );
      expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(false);
      const { body } = await server.api('GET', `/api/conversations/${convo.id}/events`);
      expect((body.events as any[]).some((e) => e.type === 'lifecycle' && e.payload.event === 'idle_timeout')).toBe(true);
    });

    it('marks active Conversations ended on a server restart; the transcript survives', async () => {
      server = await startServer(stubHarness());
      const convo = await firstTurn(server, 'survive as history');
      expect((await server.api('GET', `/api/conversations/${convo.id}`)).body.state).toBe('active');

      const dataDir = server.dataDir;
      await server.app.close();
      server = await startServer(stubHarness(), { dataDir });

      const restored = await server.api('GET', `/api/conversations/${convo.id}`);
      expect(restored.body.state).toBe('ended');
      const events = await server.api('GET', `/api/conversations/${convo.id}/events`);
      expect((events.body.events as any[]).some((e) => e.type === 'user_turn')).toBe(true);
      const turn = await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: 'nope' });
      expect(turn.status).toBe(409);
    });
  });
});

describe('conversation-telemetry', () => {
  const acpTurn = (usage: Record<string, number>) => JSON.stringify({ updates: [], usage });

  describe('conversation usage accumulation (unit)', () => {
    const aggregate = (t: Partial<AttemptUsage['totals'] & object>): AttemptUsage => ({
      models: {},
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: null, ...t },
      toolCalls: {},
      source: 'acp',
    });

    it('accumulates ACP-aggregate totals across Turns', () => {
      const a = aggregate({ inputTokens: 100, outputTokens: 50 });
      const b = aggregate({ inputTokens: 200, outputTokens: 30 });
      const merged = accumulateUsage(a, b)!;
      expect(merged.totals).toMatchObject({ inputTokens: 300, outputTokens: 80 });
    });

    it('replaces with a cumulative per-model source (session log)', () => {
      const stored = aggregate({ inputTokens: 100, outputTokens: 50 });
      const cumulative: AttemptUsage = {
        models: { 'claude-sonnet-5': { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        totals: null,
        toolCalls: {},
        source: 'session-log',
      };
      expect(accumulateUsage(stored, cumulative)).toBe(cumulative);
    });

    it('derives context fill from the input side of an ACP result', () => {
      expect(contextInputTokens({ inputTokens: 10, cachedReadTokens: 5, cachedWriteTokens: 2 })).toBe(17);
      expect(contextInputTokens(undefined)).toBeNull();
    });
  });

  describe('conversation telemetry (issue 12)', () => {
    let server: TestServer;
    afterEach(async () => {
      await server?.close();
    });

    it('accumulates running tokens across Turns and tracks the latest context fill', async () => {
      server = await startServer(stubHarness());
      const { body: convo } = await server.api('POST', '/api/conversations', {});

      await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: acpTurn({ inputTokens: 100, outputTokens: 50 }) });
      await waitFor(async () => {
        const { body } = await server.api('GET', `/api/conversations/${convo.id}`);
        return body.usage?.totals?.outputTokens === 50 ? body : undefined;
      });

      await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: acpTurn({ inputTokens: 200, outputTokens: 30 }) });
      const after = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/conversations/${convo.id}`);
        return body.usage?.totals?.outputTokens === 80 ? body : undefined;
      });
      expect(after.usage.totals).toMatchObject({ inputTokens: 300, outputTokens: 80 });
      expect(after.contextTokens).toBe(200);
    });

    it('follows the honest-incomplete rule for cost when no per-model split is available', async () => {
      server = await startServer(stubHarness());
      const { body: convo } = await server.api('POST', '/api/conversations', {});
      await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: acpTurn({ inputTokens: 100, outputTokens: 50 }) });
      const after = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/conversations/${convo.id}`);
        return body.usage ? body : undefined;
      });
      expect(after.cost.incomplete).toBe(true);
      expect(after.cost.totalUsd).toBeNull();
    });

    it('uses the harness cache warmth when no model context window is configured', async () => {
      server = await startServer(stubHarness());
      const { body: convo } = await server.api('POST', '/api/conversations', {});
      expect(convo.contextWindow).toBeNull();
      expect(convo.cacheWarmSeconds).toBe(300);
    });

    it('exposes a model context window and harness cache warmth', async () => {
      server = await startServer({
        harnesses: {
          claude: {
            command: process.execPath,
            args: [],
            env: {},
            models: [{ id: 'stub-model', contextWindow: 1000 }],
            defaultModel: 'stub-model',
            cacheWarmSeconds: 60,
          },
        },
        chat: { harness: 'claude', model: 'stub-model' },
      });
      const { body: convo } = await server.api('POST', '/api/conversations', {});
      expect(convo.contextWindow).toBe(1000);
      expect(convo.cacheWarmSeconds).toBe(60);
    });
  });
});

describe('conversation-rules', () => {
  const connectWs = (server: TestServer) => connectFirehose(server);

  async function events(server: TestServer, id: number): Promise<any[]> {
    return (await server.api('GET', `/api/conversations/${id}/events`)).body.events;
  }

  async function ask(server: TestServer, ws: { messages: any[] }, convoId: number, kind = 'edit') {
    await server.api('POST', `/api/conversations/${convoId}/turns`, {
      text: JSON.stringify({ requestPermission: { title: `${kind} thing`, kind }, updates: [] }),
    });
    return waitFor(async () => ws.messages.find((m) => m.type === 'permission_request' && m.conversationId === convoId));
  }

  describe('persistent permission rules (issue 13)', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer(stubHarness());
    });
    afterAll(async () => {
      await server.close();
    });

    it('"Always allow in {dir}" writes a rule that auto-approves matching requests across Conversations', async () => {
      const ws = await connectWs(server);

      const { body: a } = await server.api('POST', '/api/conversations', {});
      const pending = await ask(server, ws, a.id, 'edit');
      const allowOnce = pending.request.options.find((o: any) => o.kind === 'allow_once');
      await server.api('POST', `/api/conversations/${a.id}/permissions/${pending.reqId}`, {
        optionId: allowOnce.optionId,
        remember: true,
      });

      const rules = await waitFor(async () => {
        const { body } = await server.api('GET', '/api/permission-rules');
        return body.rules.length > 0 ? body.rules : undefined;
      });
      expect(rules[0]).toMatchObject({ kind: 'edit', workingDir: a.workingDir });

      const { body: b } = await server.api('POST', '/api/conversations', {});
      const before = ws.messages.filter((m) => m.type === 'permission_request').length;
      await server.api('POST', `/api/conversations/${b.id}/turns`, {
        text: JSON.stringify({ requestPermission: { title: 'edit thing', kind: 'edit' }, updates: [] }),
      });
      const resolved = await waitFor(async () =>
        (await events(server, b.id)).find((e) => e.type === 'permission_request'),
      );
      expect(resolved.payload.rule).toEqual({ kind: 'edit', workingDir: b.workingDir });
      expect(resolved.payload.outcome.outcome).toBe('selected');
      expect(ws.messages.filter((m) => m.type === 'permission_request' && m.conversationId === b.id)).toHaveLength(0);
      expect(ws.messages.filter((m) => m.type === 'permission_request').length).toBe(before);

      ws.close();
    });

    it('a non-matching request (different kind or dir) still prompts', async () => {
      const ws = await connectWs(server);
      const { body: a } = await server.api('POST', '/api/conversations', {});
      const promptDifferentKind = await ask(server, ws, a.id, 'execute');
      expect(promptDifferentKind.request.toolCall.kind).toBe('execute');

      const { body: b } = await server.api('POST', '/api/conversations', { workingDir: tmpdir() });
      const promptDifferentDir = await ask(server, ws, b.id, 'edit');
      expect(promptDifferentDir.conversationId).toBe(b.id);

      ws.close();
    });

    it('lists rules and, once revoked, matching requests prompt again', async () => {
      const ws = await connectWs(server);
      const { body } = await server.api('GET', '/api/permission-rules');
      const rule = body.rules.find((r: any) => r.kind === 'edit');
      expect(rule).toBeTruthy();

      const del = await server.api('DELETE', `/api/permission-rules/${rule.id}`);
      expect(del.status).toBe(200);
      expect((await server.api('GET', '/api/permission-rules')).body.rules.some((r: any) => r.id === rule.id)).toBe(false);

      const { body: c } = await server.api('POST', '/api/conversations', {});
      const prompt = await ask(server, ws, c.id, 'edit');
      expect(prompt.request.toolCall.kind).toBe('edit');

      const missing = await server.api('DELETE', '/api/permission-rules/999999');
      expect(missing.status).toBe(404);

      ws.close();
    });
  });
});

describe('conversation-keys', () => {
  const conversationKeyRows = (server: TestServer) =>
    server.app.ctx.asyncDb.read((d) => d.select().from(apiKeys).where(eq(apiKeys.scope, 'conversation')).all());

  async function echoTurn(server: TestServer) {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY', 'HARMONIC_MCP_URL'], updates: [] }),
    });
    const echo = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/conversations/${convo.id}/events`);
      return (body.events as any[]).find((e) => e.payload?.content?.text?.startsWith('{'));
    });
    return { convo, env: JSON.parse(echo.payload.content.text) as Record<string, string> };
  }

  describe('conversation key lifecycle (issue 16)', () => {
    let server: TestServer;
    afterEach(async () => {
      await server?.close();
    });

    it('mints and injects a Conversation Key + MCP endpoint on spawn', async () => {
      server = await startServer(stubHarness());
      const { env } = await echoTurn(server);
      expect(env.HARMONIC_API_KEY).toMatch(/^adk_/);
      expect(env.HARMONIC_MCP_URL).toContain('/mcp');
      const rows = await conversationKeyRows(server);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scope).toBe('conversation');
    });

    it('lets the chatting agent create a Task over MCP with zero setup', async () => {
      server = await startServer(stubHarness());
      const { body: convo } = await server.api('POST', '/api/conversations', {});
      await server.api('POST', `/api/conversations/${convo.id}/turns`, {
        text: JSON.stringify({ mcpCreateTask: { prompt: 'scheduled from a conversation' }, updates: [] }),
      });
      await waitFor(async () => {
        const { body } = await server.api('GET', '/api/tasks');
        return (body.tasks as any[]).some((t) => t.summary === 'scheduled from a conversation') || undefined;
      });
    });

    it('never lists Conversation Keys among operator API keys, even while active', async () => {
      server = await startServer(stubHarness());
      await server.api('POST', '/api/keys', { name: 'ops' });
      await echoTurn(server);
      expect((await conversationKeyRows(server)).length).toBe(1);
      const { body } = await server.api('GET', '/api/keys');
      expect(body.keys.map((k: any) => k.name)).toEqual(['ops']);
      expect(body.keys.every((k: any) => k.scope === 'full')).toBe(true);
    });

    it('deletes the Conversation Key when the Conversation ends; the token stops authenticating', async () => {
      server = await startServer(stubHarness());
      const { convo, env } = await echoTurn(server);
      expect((await conversationKeyRows(server)).length).toBe(1);

      await server.api('POST', `/api/conversations/${convo.id}/end`);
      expect(await conversationKeyRows(server)).toEqual([]);
      const res = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { authorization: `Bearer ${env.HARMONIC_API_KEY}` },
      });
      expect(res.status).toBe(401);
    });

    it('scopes the key to the agent surface — operator endpoints are forbidden', async () => {
      server = await startServer(stubHarness());
      const { env } = await echoTurn(server);
      const token = env.HARMONIC_API_KEY;
      const tasks = await fetch(`${server.baseUrl}/api/tasks`, { headers: { authorization: `Bearer ${token}` } });
      expect(tasks.status).toBe(200);
      const config = await fetch(`${server.baseUrl}/api/config`, { headers: { authorization: `Bearer ${token}` } });
      expect(config.status).toBe(403);
      const convos = await fetch(`${server.baseUrl}/api/conversations`, { headers: { authorization: `Bearer ${token}` } });
      expect(convos.status).toBe(403);
    });

    it('startup sweep deletes orphaned conversation keys, not operator keys', async () => {
      server = await startServer(stubHarness());
      const orphan = await server.app.ctx.auth.createKey('conversation-999', { scope: 'conversation', conversationId: 999 });
      const operator = await server.api('POST', '/api/keys', { name: 'ops' });

      const dataDir = server.dataDir;
      await server.app.close();
      server = await startServer(stubHarness(), { dataDir });

      expect(await conversationKeyRows(server)).toEqual([]);
      const orphanRes = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { authorization: `Bearer ${orphan.token}` },
      });
      expect(orphanRes.status).toBe(401);
      const opRes = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { authorization: `Bearer ${operator.body.token}` },
      });
      expect(opRes.status).toBe(200);
    });
  });
});

describe('conversation-permissions', () => {
  const connectWs = (server: TestServer) => connectFirehose(server);

  async function events(server: TestServer, id: number): Promise<any[]> {
    return (await server.api('GET', `/api/conversations/${id}/events`)).body.events;
  }

  async function askPermission(server: TestServer, ws: { messages: any[] }) {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ requestPermission: { title: 'Write file' }, updates: [] }),
    });
    const pending = await waitFor(async () =>
      ws.messages.find((m) => m.type === 'permission_request' && m.conversationId === convo.id),
    );
    return { convo, reqId: pending.reqId as string, request: pending.request };
  }

  describe('interactive conversation permissions (issue 11)', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer(stubHarness());
    });
    afterAll(async () => {
      await server.close();
    });

    it('holds the request open, broadcasts it, and the Turn waits until answered', async () => {
      const ws = await connectWs(server);
      const { convo, reqId, request } = await askPermission(server, ws);

      expect(request.options.map((o: any) => o.kind)).toContain('allow_once');
      expect((await events(server, convo.id)).some((e) => e.type === 'permission_request')).toBe(false);

      const allowOnce = request.options.find((o: any) => o.kind === 'allow_once');
      const res = await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, {
        optionId: allowOnce.optionId,
      });
      expect(res.status).toBe(200);

      const resolved = await waitFor(async () =>
        (await events(server, convo.id)).find((e) => e.type === 'permission_request'),
      );
      expect(resolved.payload.outcome).toEqual({ outcome: 'selected', optionId: allowOnce.optionId });
      expect(resolved.payload.reqId).toBe(reqId);
      const echoed = await waitFor(async () =>
        (await events(server, convo.id)).find(
          (e) => e.type === 'session_update' && String(e.payload?.content?.text ?? '').startsWith('permission:'),
        ),
      );
      // The harness receives an ACP RequestPermissionResponse with the outcome
      // nested under `outcome`; a bare outcome is read as a reject.
      expect(JSON.parse(String(echoed.payload.content.text).slice('permission:'.length))).toEqual({
        outcome: { outcome: 'selected', optionId: allowOnce.optionId },
      });
      ws.close();
    });

    it('forwards the native allow_always option for "Allow for this conversation"', async () => {
      const ws = await connectWs(server);
      const { convo, reqId, request } = await askPermission(server, ws);
      const allowAlways = request.options.find((o: any) => o.kind === 'allow_always');
      await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId: allowAlways.optionId });
      const resolved = await waitFor(async () =>
        (await events(server, convo.id)).find((e) => e.type === 'permission_request'),
      );
      expect(resolved.payload.outcome.optionId).toBe(allowAlways.optionId);
      ws.close();
    });

    it('honours a reject option', async () => {
      const ws = await connectWs(server);
      const { convo, reqId, request } = await askPermission(server, ws);
      const reject = request.options.find((o: any) => o.kind.startsWith('reject'));
      await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId: reject.optionId });
      const resolved = await waitFor(async () =>
        (await events(server, convo.id)).find((e) => e.type === 'permission_request'),
      );
      expect(resolved.payload.outcome.optionId).toBe(reject.optionId);
      ws.close();
    });

    it('rejects answering an unknown or already-resolved request', async () => {
      const ws = await connectWs(server);
      const { convo, reqId, request } = await askPermission(server, ws);
      const optionId = request.options[0].optionId;
      await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId });
      const again = await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId });
      expect(again.status).toBe(404);
      const bogus = await server.api('POST', `/api/conversations/${convo.id}/permissions/perm-999999`, { optionId });
      expect(bogus.status).toBe(404);
      ws.close();
    });

    it('cleans up a pending request when the Conversation ends, never leaking it', async () => {
      const ws = await connectWs(server);
      const { convo, reqId } = await askPermission(server, ws);

      await server.api('POST', `/api/conversations/${convo.id}/end`);

      const cancelled = await waitFor(async () =>
        (await events(server, convo.id)).find((e) => e.type === 'permission_request' && e.payload.reqId === reqId),
      );
      expect(cancelled.payload.outcome).toEqual({ outcome: 'cancelled' });
      expect((await server.api('GET', `/api/conversations/${convo.id}`)).body.state).toBe('ended');
      const answer = await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId: 'x' });
      expect(answer.status).toBe(404);
      ws.close();
    });
  });
});
