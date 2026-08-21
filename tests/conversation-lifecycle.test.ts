import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { apiKeys, conversationEvents } from '../src/db/schema.js';

/** Send a first Turn and wait for it to finish, so the conversation is warm and idle. */
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

    // Derived title = the first Turn's first non-empty line.
    let got = (await server.api('GET', `/api/conversations/${convo.id}`)).body;
    expect(got.title).toBe('Refactor the ACP connection handling');

    // Operator rename wins.
    const renamed = await server.api('PATCH', `/api/conversations/${convo.id}`, { title: 'Parser work' });
    expect(renamed.body.title).toBe('Parser work');

    // Clearing it falls back to the derived title.
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
    expect(ids.slice(0, 2)).toEqual([b.id, a.id]); // reverse-chronological
    expect((body.conversations as any[]).find((c) => c.id === b.id).state).toBe('ended');
  });

  it('deletes a Conversation, cascading its events and revoking its key', async () => {
    server = await startServer(stubHarness());
    const convo = await firstTurn(server, 'to be deleted');
    // It has events and a live conversation key while warm.
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

    // ~1.8s idle → ended, harness stopped, recorded honestly.
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
    // Its transcript is intact and read-only — a further Turn is refused.
    const events = await server.api('GET', `/api/conversations/${convo.id}/events`);
    expect((events.body.events as any[]).some((e) => e.type === 'user_turn')).toBe(true);
    const turn = await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: 'nope' });
    expect(turn.status).toBe(409);
  });
});
