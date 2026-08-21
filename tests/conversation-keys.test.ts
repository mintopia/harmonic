import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { apiKeys } from '../src/db/schema.js';

const conversationKeyRows = (server: TestServer) =>
  server.app.ctx.asyncDb.read((d) => d.select().from(apiKeys).where(eq(apiKeys.scope, 'conversation')).all());

/** Run one Turn that echoes the injected key, and return the conversation + token. */
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
    // Exactly one conversation key exists, and it is never an operator key.
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
      return (body.tasks as any[]).some((t) => t.prompt === 'scheduled from a conversation') || undefined;
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
    // Reaches the agent surface (tasks)…
    const tasks = await fetch(`${server.baseUrl}/api/tasks`, { headers: { authorization: `Bearer ${token}` } });
    expect(tasks.status).toBe(200);
    // …but not operator-only surfaces (config, the Conversations API itself).
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
