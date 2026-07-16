import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

/** Collect WS messages into an inspectable list. */
async function connectWs(server: TestServer): Promise<{ messages: any[]; close: () => void }> {
  const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
  const messages: any[] = [];
  ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return { messages, close: () => ws.close() };
}

/** Poll a Conversation's persisted events until `predicate` matches. */
async function waitForEvent(server: TestServer, id: number, predicate: (e: any) => boolean) {
  return waitFor(async () => {
    const { body } = await server.api('GET', `/api/conversations/${id}/events`);
    return (body.events as any[]).find(predicate);
  });
}

describe('conversation walking skeleton (issue 10)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('creates a Conversation without spawning a harness', async () => {
    const { body, status } = await server.api('POST', '/api/conversations', {});
    expect(status).toBe(201);
    expect(body.state).toBe('active');
    expect(body.sessionId).toBeNull();
    // Defaults come from config, like tasks.
    expect(body.harness).toBe('claude');
    expect(body.workingDir).toBeTruthy();
    expect(server.app.ctx.conversationDriver.isWarm(body.id)).toBe(false);
  });

  it('spawns on the first Turn, streams the reply, and persists a replayable transcript', async () => {
    const ws = await connectWs(server);
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'there' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' },
    ];
    const turn = await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates, delayMs: 10 }),
    });
    expect(turn.status).toBe(200);
    expect(turn.body).toEqual({ ok: true, queued: false });

    // The harness spawned and the ACP session was created.
    await waitFor(async () => (await server.api('GET', `/api/conversations/${convo.id}`)).body.sessionId !== null);
    expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(true);

    // The reply streamed over the firehose.
    await waitFor(async () =>
      ws.messages.some(
        (m) => m.type === 'conversation_event' && m.event.conversationId === convo.id && m.event.type === 'session_update',
      ),
    );
    await waitForEvent(server, convo.id, (e) => e.type === 'lifecycle' && e.payload.event === 'finished');

    // Replay renders from the same persisted records: the operator's Turn is
    // recorded, agent output follows, and the WS stream equals the REST replay.
    const replay = await server.api('GET', `/api/conversations/${convo.id}/events`);
    const events = replay.body.events as any[];
    expect(events[0]).toMatchObject({ type: 'user_turn' });
    // The operator's Turn text is stored verbatim (here, the stub scenario).
    expect(events[0].payload.text).toContain('agent_message_chunk');
    const streamedUpdates = ws.messages
      .filter((m) => m.type === 'conversation_event' && m.event.conversationId === convo.id && m.event.type === 'session_update')
      .map((m) => m.event);
    const replayUpdates = events.filter((e) => e.type === 'session_update');
    expect(replayUpdates).toEqual(streamedUpdates);
    expect(replayUpdates.map((e: any) => e.payload.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
    ]);

    ws.close();
  });

  it('reuses the warm session on a second Turn (no re-spawn)', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } }] }),
    });
    await waitForEvent(server, convo.id, (e) => e.type === 'lifecycle' && e.payload.event === 'finished');
    const afterFirst = await server.api('GET', `/api/conversations/${convo.id}`);
    const sessionId = afterFirst.body.sessionId;
    expect(sessionId).toBeTruthy();
    const activeCountAfterFirst = server.app.ctx.conversationDriver.activeCount;

    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } }] }),
    });
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/conversations/${convo.id}/events`);
      return (body.events as any[]).filter((e) => e.type === 'user_turn').length === 2;
    });
    await waitForEvent(server, convo.id, (e) =>
      e.type === 'session_update' && e.payload?.content?.text === 'two',
    );

    // Same session id, and no extra warm process appeared — the harness was reused.
    const afterSecond = await server.api('GET', `/api/conversations/${convo.id}`);
    expect(afterSecond.body.sessionId).toBe(sessionId);
    expect(server.app.ctx.conversationDriver.activeCount).toBe(activeCountAfterFirst);
  });

  it('ends a Conversation: stops the harness and marks it ended; further Turns are rejected', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }] }),
    });
    await waitFor(async () => server.app.ctx.conversationDriver.isWarm(convo.id));

    const ended = await server.api('POST', `/api/conversations/${convo.id}/end`);
    expect(ended.body.state).toBe('ended');
    expect(ended.body.endedAt).toBeTruthy();
    expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(false);

    const rejected = await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [] }),
    });
    expect(rejected.status).toBe(409);
  });

  it('validates the working directory exists before spawning', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {
      workingDir: '/no/such/harmonic/dir',
    });
    const turn = await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [] }),
    });
    expect(turn.status).toBe(400);
    expect(turn.body.error.code).toBe('validation');
  });

  it('never lets a run-scoped key reach the operator-only Conversation API', async () => {
    // A Conversation route is not in the run-scoped allowlist (app.ts).
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    const key = server.app.ctx.auth.createKey('run-1', { scope: 'run', runId: 1 });
    const res = await fetch(`${server.baseUrl}/api/conversations/${convo.id}`, {
      headers: { authorization: `Bearer ${key.token}` },
    });
    expect(res.status).toBe(403);
  });
});
