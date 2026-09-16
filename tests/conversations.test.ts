import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, connectFirehose, type TestServer } from './helpers.js';

const connectWs = (server: TestServer) => connectFirehose(server);

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

  it('opens a Conversation with a warm harness and advertised commands before its first Turn', async () => {
    const commands = [{ name: 'review', description: 'Review the current changes' }];
    const config = stubHarness();
    config.harnesses!.claude!.env = { STUB_AVAILABLE_COMMANDS: JSON.stringify(commands) };
    const eagerServer = await startServer(config);
    try {
      const { body, status } = await eagerServer.api('POST', '/api/conversations', {});
      expect(status).toBe(201);
      expect(body.state).toBe('active');
      expect(body.sessionId).toEqual(expect.any(String));
      expect(body.harness).toBe('claude');
      expect(body.workingDir).toBeTruthy();
      expect(body.commands).toEqual(commands);
      expect(body.usage).toBeNull();
      expect(body.cost).toBeNull();
      expect(eagerServer.app.ctx.conversationDriver.isWarm(body.id)).toBe(true);

      const events = await eagerServer.api('GET', `/api/conversations/${body.id}/events`);
      expect(events.body.events.filter((event: { type: string }) => event.type === 'user_turn')).toEqual([]);
    } finally {
      await eagerServer.close();
    }
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

    await waitFor(async () => (await server.api('GET', `/api/conversations/${convo.id}`)).body.sessionId !== null);
    expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(true);

    await waitFor(async () =>
      ws.messages.some(
        (m) => m.type === 'conversation_event' && m.event.conversationId === convo.id && m.event.type === 'session_update',
      ),
    );
    await waitForEvent(server, convo.id, (e) => e.type === 'lifecycle' && e.payload.event === 'finished');

    const replay = await server.api('GET', `/api/conversations/${convo.id}/events`);
    const events = replay.body.events as any[];
    expect(events[0]).toMatchObject({ type: 'user_turn' });
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

  it('exposes the harness advertised commands through detail and the firehose', async () => {
    const ws = await connectWs(server);
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    const commands = [
      { name: 'review', description: 'Review the current changes', input: { hint: 'focus area' } },
      { name: 'status', description: 'Show the current status' },
    ];

    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [{ sessionUpdate: 'available_commands_update', availableCommands: commands }] }),
    });

    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/conversations/${convo.id}`);
      return body.commands?.length === commands.length ? body : undefined;
    });
    const detail = await server.api('GET', `/api/conversations/${convo.id}`);
    expect(detail.body.commands).toEqual([
      { name: 'review', description: 'Review the current changes', argumentHint: 'focus area' },
      { name: 'status', description: 'Show the current status' },
    ]);
    const commandsMsg = await waitFor(async () =>
      ws.messages.find(
        (message) =>
          message.type === 'conversation_commands' &&
          message.conversationId === convo.id &&
          message.commands?.length === detail.body.commands.length,
      ),
    );
    expect(commandsMsg).toMatchObject({ commands: detail.body.commands });

    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [{ sessionUpdate: 'available_commands_update', availableCommands: [] }] }),
    });
    await waitFor(async () => (await server.api('GET', `/api/conversations/${convo.id}`)).body.commands?.length === 0);
    expect((await server.api('GET', `/api/conversations/${convo.id}`)).body.commands).toEqual([]);
    ws.close();
  });

  it('restores commands replayed while resuming a session', async () => {
    const config = stubHarness();
    config.harnesses!.claude!.env = {
      STUB_REPLAY_ON_LOAD: JSON.stringify([
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'resume', description: 'Resume work', input: { hint: 'task' } }],
        },
      ]),
    };
    const resumedServer = await startServer(config);
    try {
      const { body: convo } = await resumedServer.api('POST', '/api/conversations', {});
      await resumedServer.api('POST', `/api/conversations/${convo.id}/turns`, { text: 'first turn' });
      await waitFor(async () => (await resumedServer.api('GET', `/api/conversations/${convo.id}`)).body.sessionId !== null);
      await resumedServer.api('POST', `/api/conversations/${convo.id}/end`);
      await resumedServer.api('POST', `/api/conversations/${convo.id}/turns`, { text: 'second turn' });
      await waitFor(async () => (await resumedServer.api('GET', `/api/conversations/${convo.id}`)).body.commands?.length === 1);
      expect((await resumedServer.api('GET', `/api/conversations/${convo.id}`)).body.commands).toEqual([
        { name: 'resume', description: 'Resume work', argumentHint: 'task' },
      ]);
    } finally {
      await resumedServer.close();
    }
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

    const afterSecond = await server.api('GET', `/api/conversations/${convo.id}`);
    expect(afterSecond.body.sessionId).toBe(sessionId);
    expect(server.app.ctx.conversationDriver.activeCount).toBe(activeCountAfterFirst);
  });

  it('ends a Conversation: stops the harness; a later Turn resumes it from its stored session', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }] }),
    });
    await waitFor(async () => server.app.ctx.conversationDriver.isWarm(convo.id));
    const sessionId = (await server.api('GET', `/api/conversations/${convo.id}`)).body.sessionId;
    expect(sessionId).toBeTruthy();

    const ended = await server.api('POST', `/api/conversations/${convo.id}/end`);
    expect(ended.body.state).toBe('ended');
    expect(ended.body.endedAt).toBeTruthy();
    expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(false);
    expect((await server.api('GET', `/api/conversations/${convo.id}`)).body.coldResume).toBe(true);

    const resumed = await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'again' } }] }),
    });
    expect(resumed.status).toBe(200);
    await waitFor(async () => (await server.api('GET', `/api/conversations/${convo.id}`)).body.state === 'active');
    const after = await server.api('GET', `/api/conversations/${convo.id}`);
    expect(after.body.sessionId).toBe(sessionId);
    expect(after.body.endedAt).toBeNull();
  });

  it('resumes a Conversation ended before its first Turn', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    expect(convo.sessionId).toEqual(expect.any(String));
    const ended = await server.api('POST', `/api/conversations/${convo.id}/end`);
    expect(ended.body.state).toBe('ended');

    const resumed = await server.api('POST', `/api/conversations/${convo.id}/turns`, {
      text: JSON.stringify({ updates: [] }),
    });
    expect(resumed.status).toBe(200);
  });

  it('validates the working directory exists before spawning', async () => {
    const created = await server.api('POST', '/api/conversations', {
      workingDir: '/no/such/harmonic/dir',
    });
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe('validation');
    expect((await server.api('GET', '/api/conversations')).body.conversations).not.toContainEqual(
      expect.objectContaining({ workingDir: '/no/such/harmonic/dir' }),
    );
  });

  it('never lets an attempt-scoped key reach the operator-only Conversation API', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    const key = await server.app.ctx.auth.createKey('run-1', { scope: 'attempt', attemptId: 1 });
    const res = await fetch(`${server.baseUrl}/api/conversations/${convo.id}`, {
      headers: { authorization: `Bearer ${key.token}` },
    });
    expect(res.status).toBe(403);
  });
});
