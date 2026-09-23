import { isDeepStrictEqual } from 'node:util';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, connectFirehose, cancelRunningTasks, type TestServer } from './helpers.js';

describe('live structured run event streaming and replay', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('streams ACP updates without persisting them for REST replay', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' },
      { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'medium' }] },
    ];
    const ws = await connectFirehose(server);

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ updates, delayMs: 40 }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const attemptId = started.body.id;
    ws.send({ type: 'attempt_log_subscribe', attemptId, after: 0 });

    await waitFor(async () =>
      ws.messages.some((m) => m.type === 'attempt_changed' && m.run.id === attemptId && m.run.state !== 'running'),
    );

    const streamed = ws.messages.filter(
      (m) => m.type === 'attempt_log_event' && m.event.attemptId === attemptId && m.event.type === 'session_update',
    );
    expect(streamed.map((m) => m.event.payload.sessionUpdate)).toEqual(updates.map((update) => update.sessionUpdate));
    expect(streamed.map((m) => m.event.id)).toEqual([1_000_000_001, 1_000_000_002, 1_000_000_003, 1_000_000_004]);

    const replay = await server.api('GET', `/api/attempts/${attemptId}/events`);
    const replayUpdates = replay.body.events.filter((e: any) => e.type === 'session_update');
    expect(replayUpdates).toEqual([]);

    ws.close();
  });

  it('replays missed transient log events in order after a WebSocket reconnect', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'three' } },
    ];
    const first = await connectFirehose(server);
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ updates, delayMs: 80 }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const attemptId = started.body.id;
    first.send({ type: 'attempt_log_subscribe', attemptId, after: 0 });
    await waitFor(async () => first.messages.some((m) => m.type === 'attempt_log_event' && m.event.attemptId === attemptId && m.event.seq === 1));
    first.close();

    await waitFor(async () => (await server.api('GET', `/api/attempts/${attemptId}`)).body.state !== 'running');
    const reconnected = await connectFirehose(server);
    reconnected.send({ type: 'attempt_log_subscribe', attemptId, after: 1 });
    await waitFor(async () => reconnected.messages.filter((m) => m.type === 'attempt_log_event' && m.event.attemptId === attemptId).length === 2);
    const replayed = reconnected.messages.filter((m) => m.type === 'attempt_log_event' && m.event.attemptId === attemptId);
    expect(replayed.map((m) => m.event.seq)).toEqual([2, 3]);
    reconnected.close();
  });

  it('broadcasts task state changes so the board updates without polling', async () => {
    const ws = await connectFirehose(server);
    const created = await server.api('POST', '/api/tasks', { prompt: 'plain prompt' });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);

    await waitFor(async () =>
      ws.messages.some(
        (m) => m.type === 'task_changed' && m.task.id === created.body.id && m.task.state === 'done',
      ),
    );
    ws.close();
  });

  it('task_changed payloads carry the API task shape, identical to REST', async () => {
    const ws = await connectFirehose(server);
    const dep = await server.api('POST', '/api/tasks', { prompt: 'dependency', state: 'draft' });
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'dependent',
      dependsOn: [dep.body.id],
    });

    await waitFor(async () =>
      ws.messages.some((m) => m.type === 'task_changed' && m.task.id === created.body.id),
    );
    let rest = await server.api('GET', `/api/tasks/${created.body.id}`);
    const msg = await waitFor(async () => {
      rest = await server.api('GET', `/api/tasks/${created.body.id}`);
      const latest = ws.messages.findLast((m) => m.type === 'task_changed' && m.task.id === created.body.id);
      return latest && isDeepStrictEqual(latest.task, rest.body) ? latest : undefined;
    });

    expect(msg.task.dependsOn).toEqual([dep.body.id]);
    expect(msg.task.dependents).toEqual([]);
    expect(msg.task.blockedOnFailed).toBe(false);
    expect(msg.task.openBlockerCount).toBe(1);
    expect(msg.task.humanOnly).toBe(false);

    expect(msg.task).toEqual(rest.body);
    ws.close();
  });

  it('never lets a slow, older task_changed overtake a newer one for the same task', async () => {
    const ws = await connectFirehose(server);
    const created = await server.api('POST', '/api/tasks', { prompt: 'original', state: 'draft' });
    const row = await server.app.ctx.tasks.get(created.body.id);
    const tasks = server.app.ctx.tasks;
    const withDeps = tasks.withDeps.bind(tasks);
    let delayNext = true;
    tasks.withDeps = async (task) => {
      if (delayNext) {
        delayNext = false;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return withDeps(task);
    };

    try {
      server.app.ctx.bus.emit('task_changed', { ...row, prompt: 'older' });
      server.app.ctx.bus.emit('task_changed', { ...row, prompt: 'newer' });
      await waitFor(async () =>
        ws.messages.some((m) => m.type === 'task_changed' && m.task.id === created.body.id && m.task.prompt === 'newer'),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      tasks.withDeps = withDeps;
    }

    const latest = ws.messages.findLast((m) => m.type === 'task_changed' && m.task.id === created.body.id);
    expect(latest.task.prompt).toBe('newer');
    ws.close();
  });

  it('never sends a slow task_changed after that task was removed', async () => {
    const ws = await connectFirehose(server);
    const created = await server.api('POST', '/api/tasks', { prompt: 'doomed', state: 'draft' });
    const row = await server.app.ctx.tasks.get(created.body.id);
    const tasks = server.app.ctx.tasks;
    const withDeps = tasks.withDeps.bind(tasks);
    tasks.withDeps = async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return withDeps(task);
    };

    try {
      server.app.ctx.bus.emit('task_changed', { ...row, prompt: 'late' });
      server.app.ctx.bus.emit('task_removed', { id: created.body.id });
      await waitFor(async () => ws.messages.some((m) => m.type === 'task_removed' && m.id === created.body.id));
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      tasks.withDeps = withDeps;
    }

    const forTask = ws.messages.filter((m) => (m.type === 'task_changed' && m.task.id === created.body.id) || (m.type === 'task_removed' && m.id === created.body.id));
    expect(forTask.at(-1)?.type).toBe('task_removed');
    ws.close();
  });

  it('never lets a slow, older attempt_changed overtake a newer one for the same attempt', async () => {
    const ws = await connectFirehose(server);
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ exit: 'hang' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const attemptId = started.body.id;
    const row = await server.app.ctx.attempts.get(attemptId);
    const attempts = server.app.ctx.attempts;
    const listToolCalls = attempts.listToolCalls.bind(attempts);
    let delayNext = true;
    attempts.listToolCalls = async (id) => {
      if (delayNext) {
        delayNext = false;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return listToolCalls(id);
    };

    try {
      server.app.ctx.bus.emit('attempt_changed', { ...row, prompt: 'older' });
      server.app.ctx.bus.emit('attempt_changed', { ...row, prompt: 'newer' });
      await waitFor(async () =>
        ws.messages.some((m) => m.type === 'attempt_changed' && m.run.id === attemptId && m.run.prompt === 'newer'),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      attempts.listToolCalls = listToolCalls;
    }

    const latest = ws.messages.findLast((m) => m.type === 'attempt_changed' && m.run.id === attemptId);
    expect(latest.run.prompt).toBe('newer');
    ws.close();
    await cancelRunningTasks(server);
  });

  it('never lets a slow, older conversation_changed overtake a newer one for the same conversation', async () => {
    const ws = await connectFirehose(server);
    const created = await server.api('POST', '/api/conversations', {});
    const conversationId = created.body.id;
    const row = await server.app.ctx.conversations.get(conversationId);
    const conversations = server.app.ctx.conversations;
    const firstTurnText = conversations.firstTurnText.bind(conversations);
    let delayNext = true;
    conversations.firstTurnText = async (id) => {
      if (delayNext) {
        delayNext = false;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return firstTurnText(id);
    };

    try {
      server.app.ctx.bus.emit('conversation_changed', { ...row, workingDir: 'older' });
      server.app.ctx.bus.emit('conversation_changed', { ...row, workingDir: 'newer' });
      await waitFor(async () =>
        ws.messages.some(
          (m) => m.type === 'conversation_changed' && m.conversation.id === conversationId && m.conversation.workingDir === 'newer',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      conversations.firstTurnText = firstTurnText;
    }

    const latest = ws.messages.findLast((m) => m.type === 'conversation_changed' && m.conversation.id === conversationId);
    expect(latest.conversation.workingDir).toBe('newer');
    ws.close();
  });

  it('re-broadcasts a dependant when its blocker escalates, so blockedOnFailed shows live', async () => {
    const ws = await connectFirehose(server);
    const blocker = await server.api('POST', '/api/tasks', { prompt: 'blocker' });
    const dependant = await server.api('POST', '/api/tasks', { prompt: 'dependant', dependsOn: [blocker.body.id] });
    await waitFor(async () => ws.messages.some((m) => m.type === 'task_changed' && m.task.id === dependant.body.id));
    ws.messages.length = 0;

    await server.app.ctx.tasks.escalate(blocker.body.id, 'escalated to human: attempt 3 of 3 failed');

    const msg = await waitFor(async () =>
      ws.messages.find((m) => m.type === 'task_changed' && m.task.id === dependant.body.id && m.task.blockedOnFailed),
    );
    expect(msg.task).toMatchObject({ state: 'ready', openBlockerCount: 1, blockedOnFailed: true, agentWorkable: false });
    ws.close();
  });
});
